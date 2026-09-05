// WASAPI loopback recorder for Jamus.
//
// Captures whatever is playing on the default audio RENDER endpoint (your speakers/AirPods)
// and writes it to mono 16-bit PCM WAV — no Stereo Mix / virtual cable required.
//
// Usage:
//   wasapi-loopback.exe [--exclude-process <name>] <output.wav>
//   wasapi-loopback.exe [--exclude-process <name>] --segments <outDir> <segSeconds>
//
//   --exclude-process <name>   Leave one app's audio out of the capture (e.g. "Spotify.exe")
//                               while still capturing everything else on the default output
//                               device — uses Windows' per-process loopback exclusion
//                               (Windows 10 2004+ / Windows 11). Matches by process name;
//                               excludes that process's whole child-process tree. If no
//                               running process matches, falls back to capturing everything.
//
// Segmented mode: rolling N-second WAV segments (live mode) — each finalized segment is
// immediately valid, and <outDir>/segments.jsonl gets one JSON line per completed segment:
// {index,file,startMs,durationMs}
//
// Stops on: a line/EOF on stdin (the host writes to stdin to stop) or Ctrl+C.
//
// Built with the .NET Framework csc.exe that ships with Windows — no NuGet packages.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Program
{
    private const int REFTIMES_PER_SEC = 10000000;
    private const uint AUDCLNT_SHAREMODE_SHARED = 0;
    private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    private const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
    private const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
    private const int PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;
    private const ushort VT_BLOB = 65;

    private static volatile bool _stop = false;

    private const uint COINIT_MULTITHREADED = 0x0;
    private const int RO_INIT_MULTITHREADED = 1;

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

    [DllImport("combase.dll")]
    private static extern int RoInitialize(int initType);

    private static int Main(string[] args)
    {
        CoInitializeEx(IntPtr.Zero, COINIT_MULTITHREADED);
        RoInitialize(RO_INIT_MULTITHREADED);

        string excludeProcess = null;
        var rest = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--exclude-process")
            {
                if (i + 1 >= args.Length) { Console.Error.WriteLine("--exclude-process requires a process name"); return 2; }
                excludeProcess = args[++i];
            }
            else
            {
                rest.Add(args[i]);
            }
        }
        args = rest.ToArray();

        if (args.Length < 1)
        {
            Console.Error.WriteLine("Usage: wasapi-loopback.exe [--exclude-process <name>] <output.wav>");
            Console.Error.WriteLine("       wasapi-loopback.exe [--exclude-process <name>] --segments <outDir> <segSeconds>");
            return 2;
        }

        Console.CancelKeyPress += (s, e) => { e.Cancel = true; _stop = true; };
        // Stop when the host closes/writes stdin.
        var stopThread = new Thread(() => { try { Console.In.ReadLine(); } catch { } _stop = true; });
        stopThread.IsBackground = true;
        stopThread.Start();

        try
        {
            var audio = SetupAudio(excludeProcess);
            if (args[0] == "--segments")
            {
                if (args.Length < 3) { Console.Error.WriteLine("--segments requires <outDir> <segSeconds>"); return 2; }
                string outDir = args[1];
                double segSeconds = double.Parse(args[2], CultureInfo.InvariantCulture);
                Directory.CreateDirectory(outDir);
                RecordSegmented(audio, outDir, segSeconds);
            }
            else
            {
                RecordSingleFile(audio, args[0]);
            }
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[wasapi] " + ex.Message);
            return 1;
        }
    }

    // ---- shared WASAPI setup ------------------------------------------------

    private class AudioSetup
    {
        public IAudioClient Client;
        public IAudioCaptureClient Capture;
        public int Channels;
        public int BytesPerSample;
        public int FrameSize;
        public uint SampleRate;
        public uint BufferFrameCount;
        public SampleType Type;
    }

    private static AudioSetup SetupAudio(string excludeProcessName)
    {
        if (!string.IsNullOrEmpty(excludeProcessName))
        {
            int pid = ResolveTargetPid(excludeProcessName);
            if (pid > 0)
            {
                Console.Error.WriteLine(string.Format(
                    "[wasapi] excluding \"{0}\" (pid {1} and its child processes) from system-audio capture",
                    excludeProcessName, pid));
                return SetupProcessExcludedAudio(pid);
            }
            Console.Error.WriteLine(string.Format(
                "[wasapi] --exclude-process \"{0}\": no running process found, capturing everything",
                excludeProcessName));
        }
        return SetupDefaultEndpointAudio();
    }

    private static AudioSetup SetupDefaultEndpointAudio()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        // eRender = 0, eConsole = 0  -> default playback device, loopback-captured.
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 0, out device));

        object clientObj;
        Guid iidAudioClient = typeof(IAudioClient).GUID;
        Marshal.ThrowExceptionForHR(device.Activate(ref iidAudioClient, 1 /*CLSCTX_INPROC_SERVER*/, IntPtr.Zero, out clientObj));
        return BuildAudioSetup((IAudioClient)clientObj);
    }

    /// Resolves a process name (e.g. "Spotify.exe" or "Spotify") to the PID of its
    /// longest-running matching instance — the most likely root of the app's process tree.
    private static int ResolveTargetPid(string processName)
    {
        string name = processName;
        if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);

        Process[] procs;
        try { procs = Process.GetProcessesByName(name); }
        catch { return 0; }
        if (procs.Length == 0) return 0;

        Process root = procs[0];
        DateTime? earliest = TryGetStartTime(root);
        for (int i = 1; i < procs.Length; i++)
        {
            DateTime? t = TryGetStartTime(procs[i]);
            if (t.HasValue && (!earliest.HasValue || t.Value < earliest.Value))
            {
                root = procs[i];
                earliest = t;
            }
        }
        return root.Id;
    }

    private static DateTime? TryGetStartTime(Process p)
    {
        try { return p.StartTime; } catch { return null; }
    }

    /// Activates the Windows per-process loopback virtual device, configured to capture
    /// everything on the default render endpoint EXCEPT the given process's tree.
    private static AudioSetup SetupProcessExcludedAudio(int targetPid)
    {
        var activationParams = new AUDIOCLIENT_ACTIVATION_PARAMS
        {
            ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            TargetProcessId = (uint)targetPid,
            ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        };
        int paramsSize = Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
        IntPtr pParams = Marshal.AllocHGlobal(paramsSize);
        try
        {
            Marshal.StructureToPtr(activationParams, pParams, false);
            var propvariant = new PROPVARIANT_BLOB
            {
                vt = VT_BLOB,
                blobSize = (uint)paramsSize,
                blobData = pParams,
            };

            Guid iidAudioClient = typeof(IAudioClient).GUID;
            var handler = new LoopbackActivationHandler();
            IActivateAudioInterfaceAsyncOperation asyncOp;
            Marshal.ThrowExceptionForHR(Mmdevapi.ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, ref iidAudioClient, ref propvariant, handler, out asyncOp));
            handler.Wait();
            Marshal.ThrowExceptionForHR(handler.Hr);

            return BuildProcessLoopbackAudioSetup((IAudioClient)handler.Iface);
        }
        finally
        {
            Marshal.FreeHGlobal(pParams);
        }
    }

    private static AudioSetup BuildAudioSetup(IAudioClient audioClient)
    {
        IntPtr pFormat;
        Marshal.ThrowExceptionForHR(audioClient.GetMixFormat(out pFormat));
        var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
        SampleType sampleType = DetectSampleType(pFormat, fmt);
        return FinishAudioSetup(audioClient, pFormat, fmt, sampleType);
    }

    /// The per-process-loopback virtual device doesn't implement GetMixFormat (E_NOTIMPL) —
    /// it has no single "real" endpoint format to report. Supply IEEE-float 48kHz stereo,
    /// which is what the shared audio engine mixes to internally regardless of hardware format.
    private static AudioSetup BuildProcessLoopbackAudioSetup(IAudioClient audioClient)
    {
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        var fmt = new WAVEFORMATEX
        {
            wFormatTag = WAVE_FORMAT_IEEE_FLOAT,
            nChannels = 2,
            nSamplesPerSec = 48000,
            wBitsPerSample = 32,
            nBlockAlign = 8, // 2 channels * 4 bytes
            nAvgBytesPerSec = 48000u * 8,
            cbSize = 0,
        };
        IntPtr pFormat = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEFORMATEX)));
        try
        {
            Marshal.StructureToPtr(fmt, pFormat, false);
            SampleType sampleType = DetectSampleType(pFormat, fmt);
            return FinishAudioSetup(audioClient, pFormat, fmt, sampleType);
        }
        finally
        {
            Marshal.FreeHGlobal(pFormat);
        }
    }

    private static AudioSetup FinishAudioSetup(IAudioClient audioClient, IntPtr pFormat, WAVEFORMATEX fmt, SampleType sampleType)
    {
        long bufferDuration = REFTIMES_PER_SEC; // 1s buffer
        Marshal.ThrowExceptionForHR(audioClient.Initialize(
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufferDuration, 0, pFormat, Guid.Empty));

        uint bufferFrameCount;
        Marshal.ThrowExceptionForHR(audioClient.GetBufferSize(out bufferFrameCount));

        object captureObj;
        Guid iidCapture = typeof(IAudioCaptureClient).GUID;
        Marshal.ThrowExceptionForHR(audioClient.GetService(ref iidCapture, out captureObj));

        Console.Error.WriteLine(string.Format(
            "[wasapi] capturing {0} Hz, {1} ch, {2}-bit {3} -> mono 16-bit WAV",
            fmt.nSamplesPerSec, fmt.nChannels, fmt.wBitsPerSample, sampleType));

        return new AudioSetup
        {
            Client = audioClient,
            Capture = (IAudioCaptureClient)captureObj,
            Channels = fmt.nChannels,
            BytesPerSample = fmt.wBitsPerSample / 8,
            FrameSize = fmt.nBlockAlign,
            SampleRate = fmt.nSamplesPerSec,
            BufferFrameCount = bufferFrameCount,
            Type = sampleType,
        };
    }

    // ---- mode 1: single continuous file (unchanged behavior) --------------

    private static void RecordSingleFile(AudioSetup a, string outPath)
    {
        using (var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
        {
            WriteWavHeader(fs, a.SampleRate);
            long dataBytes = 0;
            byte[] raw = new byte[a.BufferFrameCount * a.FrameSize];
            int sleepMs = SleepMs(a);

            Marshal.ThrowExceptionForHR(a.Client.Start());
            while (!_stop)
            {
                Thread.Sleep(sleepMs);
                dataBytes += DrainPackets(a, ref raw, (bytes, count) => fs.Write(bytes, 0, count));
            }
            Marshal.ThrowExceptionForHR(a.Client.Stop());
            PatchWavHeader(fs, dataBytes);
        }
    }

    // ---- mode 2: rolling N-second segments (live mode) ---------------------

    private static void RecordSegmented(AudioSetup a, string outDir, double segSeconds)
    {
        byte[] raw = new byte[a.BufferFrameCount * a.FrameSize];
        int sleepMs = SleepMs(a);
        long bytesPerSecond = a.SampleRate * 2L; // mono 16-bit output
        long targetBytes = (long)(segSeconds * bytesPerSecond);

        string manifestPath = Path.Combine(outDir, "segments.jsonl");
        using (var manifest = new StreamWriter(new FileStream(manifestPath, FileMode.Create, FileAccess.Write, FileShare.Read)))
        {
            manifest.AutoFlush = true;
            int index = 0;
            long segmentStartMs = 0;

            FileStream cur = OpenSegment(outDir, index, a.SampleRate);
            long curBytes = 0;

            Marshal.ThrowExceptionForHR(a.Client.Start());
            while (!_stop)
            {
                Thread.Sleep(sleepMs);
                curBytes += DrainPackets(a, ref raw, (bytes, count) => cur.Write(bytes, 0, count));

                if (curBytes >= targetBytes)
                {
                    long durationMs = (long)(curBytes * 1000.0 / bytesPerSecond);
                    FinalizeSegment(cur, curBytes, index, outDir, segmentStartMs, durationMs, manifest);
                    segmentStartMs += durationMs;
                    index++;
                    cur = OpenSegment(outDir, index, a.SampleRate);
                    curBytes = 0;
                }
            }
            Marshal.ThrowExceptionForHR(a.Client.Stop());

            // Finalize whatever's left in the current (possibly short) segment.
            if (curBytes > 0)
            {
                long durationMs = (long)(curBytes * 1000.0 / bytesPerSecond);
                FinalizeSegment(cur, curBytes, index, outDir, segmentStartMs, durationMs, manifest);
            }
            else
            {
                cur.Close();
                try { File.Delete(SegmentPath(outDir, index)); } catch { /* ignore */ }
            }
        }
    }

    private static string SegmentPath(string outDir, int index)
    {
        return Path.Combine(outDir, "seg_" + index.ToString("D5", CultureInfo.InvariantCulture) + ".wav");
    }

    private static FileStream OpenSegment(string outDir, int index, uint sampleRate)
    {
        var fs = new FileStream(SegmentPath(outDir, index), FileMode.Create, FileAccess.Write);
        WriteWavHeader(fs, sampleRate);
        return fs;
    }

    private static void FinalizeSegment(FileStream fs, long dataBytes, int index, string outDir, long startMs, long durationMs, StreamWriter manifest)
    {
        PatchWavHeader(fs, dataBytes);
        fs.Dispose();
        manifest.WriteLine(string.Format(
            CultureInfo.InvariantCulture,
            "{{\"index\":{0},\"file\":\"{1}\",\"startMs\":{2},\"durationMs\":{3}}}",
            index, Path.GetFileName(SegmentPath(outDir, index)), startMs, durationMs));
    }

    // ---- shared packet draining ---------------------------------------------

    private static int SleepMs(AudioSetup a)
    {
        int ms = (int)(1000.0 * a.BufferFrameCount / a.SampleRate / 2.0);
        return ms < 1 ? 1 : ms;
    }

    /// Reads all currently-available packets and hands each converted mono-16 chunk to `write`.
    /// Returns the total bytes written.
    private static long DrainPackets(AudioSetup a, ref byte[] raw, Action<byte[], int> write)
    {
        long total = 0;
        uint packet;
        Marshal.ThrowExceptionForHR(a.Capture.GetNextPacketSize(out packet));
        while (packet != 0)
        {
            IntPtr pData; uint frames; uint flags; long devPos; long qpc;
            Marshal.ThrowExceptionForHR(a.Capture.GetBuffer(out pData, out frames, out flags, out devPos, out qpc));
            int byteCount = (int)(frames * a.FrameSize);
            byte[] outBytes;
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || pData == IntPtr.Zero)
            {
                outBytes = new byte[frames * 2]; // mono int16 silence
            }
            else
            {
                if (raw.Length < byteCount) raw = new byte[byteCount];
                Marshal.Copy(pData, raw, 0, byteCount);
                outBytes = DownmixToMono16(raw, (int)frames, a.Channels, a.BytesPerSample, a.Type);
            }
            write(outBytes, outBytes.Length);
            total += outBytes.Length;
            Marshal.ThrowExceptionForHR(a.Capture.ReleaseBuffer(frames));
            Marshal.ThrowExceptionForHR(a.Capture.GetNextPacketSize(out packet));
        }
        return total;
    }

    private enum SampleType { Float32, Int16, Int32, Int24, Unknown }

    private static SampleType DetectSampleType(IntPtr pFormat, WAVEFORMATEX fmt)
    {
        const ushort WAVE_FORMAT_PCM = 1;
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

        ushort tag = fmt.wFormatTag;
        if (tag == WAVE_FORMAT_EXTENSIBLE)
        {
            // SubFormat GUID sits 8 bytes past the end of the 18-byte WAVEFORMATEX.
            byte[] guid = new byte[16];
            Marshal.Copy(IntPtr.Add(pFormat, 18 + 6), guid, 0, 16);
            int sub = BitConverter.ToInt32(guid, 0);
            tag = (ushort)sub; // 1 = PCM, 3 = IEEE_FLOAT (first 4 bytes of the subformat GUID)
        }
        if (tag == WAVE_FORMAT_IEEE_FLOAT) return SampleType.Float32;
        if (tag == WAVE_FORMAT_PCM)
        {
            if (fmt.wBitsPerSample == 16) return SampleType.Int16;
            if (fmt.wBitsPerSample == 32) return SampleType.Int32;
            if (fmt.wBitsPerSample == 24) return SampleType.Int24;
        }
        return SampleType.Unknown;
    }

    private static byte[] DownmixToMono16(byte[] raw, int frames, int channels, int bytesPerSample, SampleType type)
    {
        byte[] outBytes = new byte[frames * 2];
        for (int f = 0; f < frames; f++)
        {
            double sum = 0;
            int baseIdx = f * channels * bytesPerSample;
            for (int c = 0; c < channels; c++)
            {
                int i = baseIdx + c * bytesPerSample;
                double v;
                switch (type)
                {
                    case SampleType.Float32:
                        v = BitConverter.ToSingle(raw, i); // [-1,1]
                        break;
                    case SampleType.Int16:
                        v = BitConverter.ToInt16(raw, i) / 32768.0;
                        break;
                    case SampleType.Int32:
                        v = BitConverter.ToInt32(raw, i) / 2147483648.0;
                        break;
                    case SampleType.Int24:
                        int s24 = (raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16));
                        if ((s24 & 0x800000) != 0) s24 |= unchecked((int)0xFF000000);
                        v = s24 / 8388608.0;
                        break;
                    default:
                        v = 0;
                        break;
                }
                sum += v;
            }
            double mono = sum / channels;
            if (mono > 1.0) mono = 1.0; else if (mono < -1.0) mono = -1.0;
            short s = (short)(mono * 32767);
            outBytes[f * 2] = (byte)(s & 0xFF);
            outBytes[f * 2 + 1] = (byte)((s >> 8) & 0xFF);
        }
        return outBytes;
    }

    private static void WriteWavHeader(FileStream fs, uint sampleRate)
    {
        var bw = new BinaryWriter(fs);
        bw.Write(new char[] { 'R', 'I', 'F', 'F' });
        bw.Write(0);                 // file size - 8 (patched)
        bw.Write(new char[] { 'W', 'A', 'V', 'E' });
        bw.Write(new char[] { 'f', 'm', 't', ' ' });
        bw.Write(16);                // fmt chunk size
        bw.Write((short)1);          // PCM
        bw.Write((short)1);          // mono
        bw.Write((int)sampleRate);
        bw.Write((int)(sampleRate * 2)); // byte rate (mono, 16-bit)
        bw.Write((short)2);          // block align
        bw.Write((short)16);         // bits per sample
        bw.Write(new char[] { 'd', 'a', 't', 'a' });
        bw.Write(0);                 // data size (patched)
        bw.Flush();
    }

    private static void PatchWavHeader(FileStream fs, long dataBytes)
    {
        fs.Flush();
        long fileSize = 44 + dataBytes;
        fs.Seek(4, SeekOrigin.Begin);
        var bw = new BinaryWriter(fs);
        bw.Write((int)(fileSize - 8));
        fs.Seek(40, SeekOrigin.Begin);
        bw.Write((int)dataBytes);
        bw.Flush();
    }
}

// ----- COM interop --------------------------------------------------------

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
internal class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(uint access, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out uint state);
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    int Initialize(uint shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, Guid audioSessionGuid);
    int GetBufferSize(out uint bufferFrameCount);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(uint shareMode, IntPtr format, out IntPtr closestMatch);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr handle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out long devicePosition, out long qpcPosition);
    int ReleaseBuffer(uint numFramesRead);
    int GetNextPacketSize(out uint numFramesInNextPacket);
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
internal struct WAVEFORMATEX
{
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}

// ----- per-process loopback capture (Windows 10 2004+ / Windows 11) -------

[StructLayout(LayoutKind.Sequential)]
internal struct AUDIOCLIENT_ACTIVATION_PARAMS
{
    public int ActivationType;      // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
    public uint TargetProcessId;
    public int ProcessLoopbackMode; // 0 = include process tree, 1 = exclude process tree
}

// A PROPVARIANT carrying a VT_BLOB payload — just enough of the union to pass
// AUDIOCLIENT_ACTIVATION_PARAMS through ActivateAudioInterfaceAsync.
[StructLayout(LayoutKind.Sequential)]
internal struct PROPVARIANT_BLOB
{
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public uint blobSize;
    public IntPtr blobData;
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IActivateAudioInterfaceCompletionHandler
{
    int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IActivateAudioInterfaceAsyncOperation
{
    int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

// Marker interface (no methods) declaring an object free-threaded/apartment-agnostic.
// ActivateAudioInterfaceAsync rejects its completion handler outright (E_ILLEGAL_METHOD_CALL)
// unless the handler also implements this.
[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAgileObject { }

// Receives the ActivateAudioInterfaceAsync callback (fired on a thread-pool thread) and
// hands the result back to the caller via a wait handle.
internal class LoopbackActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    private readonly ManualResetEvent _done = new ManualResetEvent(false);
    public int Hr;
    public object Iface;

    public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
    {
        int hr;
        object iface;
        activateOperation.GetActivateResult(out hr, out iface);
        Hr = hr;
        Iface = iface;
        _done.Set();
        return 0; // S_OK
    }

    public void Wait() { _done.WaitOne(); }
}

internal static class Mmdevapi
{
    [DllImport("Mmdevapi.dll")]
    internal static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        ref PROPVARIANT_BLOB activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);
}
