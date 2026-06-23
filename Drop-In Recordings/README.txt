Drop-In Recordings
==================

Put audio files you want to transcribe in THIS folder (drag them here from your
phone, Downloads, etc.). Supported: mp3, m4a, wav, aac, ogg, opus, flac, wma,
mp4, webm, 3gp, amr, and more.

Then transcribe them one of two ways:

1) Desktop app:  run  `npm run app`  →  click  "⤓ Import audio file"  →  this
   folder opens by default. Pick one file (or select several) → Transcribe.
   Each file becomes its own transcript in the app, titled by its filename.

2) Command line:
       node bin/jamus.js transcribe-file "Drop-In Recordings/my-memo.m4a"
   Options: --title "Name"  --model small.en  --me "Hayyun"  --insights

Notes:
- The file is converted automatically (any format) and transcribed as a single
  speaker (your voice). No system-audio / speaker separation for imports.
- The original file you drop here is left untouched; a converted copy is stored
  with the meeting. You can delete files from this folder anytime after importing.
