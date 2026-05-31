// WASAPI loopback recorder for Jamus.
//
// Captures whatever is playing on the default audio RENDER endpoint (your speakers/AirPods)
// and writes it to a mono 16-bit PCM WAV — no Stereo Mix / virtual cable required.
//
// Usage:   wasapi-loopback.exe <output.wav>
// Stops on: a line/EOF on stdin (the host writes to stdin to stop) or Ctrl+C.
//
// Built with the .NET Framework csc.exe that ships with Windows — no NuGet packages.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Program
{
    private const int REFTIMES_PER_SEC = 10000000;
    private const uint AUDCLNT_SHAREMODE_SHARED = 0;
    private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    private static volatile bool _stop = false;

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("Usage: wasapi-loopback.exe <output.wav>");
            return 2;
        }
        string outPath = args[0];

        Console.CancelKeyPress += (s, e) => { e.Cancel = true; _stop = true; };
        // Stop when the host closes/writes stdin.
        var stopThread = new Thread(() => { try { Console.In.ReadLine(); } catch { } _stop = true; });
        stopThread.IsBackground = true;
        stopThread.Start();

        try
        {
            Record(outPath);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[wasapi] " + ex.Message);
            return 1;
        }
    }

    private static void Record(string outPath)
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        // eRender = 0, eConsole = 0  -> default playback device, loopback-captured.
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 0, out device));

        object clientObj;
        Guid iidAudioClient = typeof(IAudioClient).GUID;
        Marshal.ThrowExceptionForHR(device.Activate(ref iidAudioClient, 1 /*CLSCTX_INPROC_SERVER*/, IntPtr.Zero, out clientObj));
        var audioClient = (IAudioClient)clientObj;

        IntPtr pFormat;
        Marshal.ThrowExceptionForHR(audioClient.GetMixFormat(out pFormat));
        var fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
        SampleType sampleType = DetectSampleType(pFormat, fmt);

        long bufferDuration = REFTIMES_PER_SEC; // 1s buffer
        Marshal.ThrowExceptionForHR(audioClient.Initialize(
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufferDuration, 0, pFormat, Guid.Empty));

        uint bufferFrameCount;
        Marshal.ThrowExceptionForHR(audioClient.GetBufferSize(out bufferFrameCount));

        object captureObj;
        Guid iidCapture = typeof(IAudioCaptureClient).GUID;
        Marshal.ThrowExceptionForHR(audioClient.GetService(ref iidCapture, out captureObj));
        var capture = (IAudioCaptureClient)captureObj;

        int channels = fmt.nChannels;
        int bytesPerSample = fmt.wBitsPerSample / 8;
        int frameSize = fmt.nBlockAlign;
        uint sampleRate = fmt.nSamplesPerSec;

        Console.Error.WriteLine(string.Format(
            "[wasapi] capturing {0} Hz, {1} ch, {2}-bit {3} -> mono 16-bit WAV",
            sampleRate, channels, fmt.wBitsPerSample, sampleType));

        using (var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
        {
            WriteWavHeader(fs, sampleRate); // patched on close
            long dataBytes = 0;
            byte[] raw = new byte[bufferFrameCount * frameSize];

            int sleepMs = (int)(1000.0 * bufferFrameCount / sampleRate / 2.0);
            if (sleepMs < 1) sleepMs = 1;

            Marshal.ThrowExceptionForHR(audioClient.Start());
            while (!_stop)
            {
                Thread.Sleep(sleepMs);
                uint packet;
                Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out packet));
                while (packet != 0)
                {
                    IntPtr pData; uint frames; uint flags; long devPos; long qpc;
                    Marshal.ThrowExceptionForHR(capture.GetBuffer(out pData, out frames, out flags, out devPos, out qpc));
                    int byteCount = (int)(frames * frameSize);
                    byte[] outBytes;
                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || pData == IntPtr.Zero)
                    {
                        outBytes = new byte[frames * 2]; // mono int16 silence
                    }
                    else
                    {
                        if (raw.Length < byteCount) raw = new byte[byteCount];
                        Marshal.Copy(pData, raw, 0, byteCount);
                        outBytes = DownmixToMono16(raw, (int)frames, channels, bytesPerSample, sampleType);
                    }
                    fs.Write(outBytes, 0, outBytes.Length);
                    dataBytes += outBytes.Length;
                    Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames));
                    Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out packet));
                }
            }
            Marshal.ThrowExceptionForHR(audioClient.Stop());
            PatchWavHeader(fs, dataBytes, sampleRate);
        }
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

    private static void PatchWavHeader(FileStream fs, long dataBytes, uint sampleRate)
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
