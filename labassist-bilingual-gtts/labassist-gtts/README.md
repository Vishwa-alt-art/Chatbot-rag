# LabAssist — Bilingual Voice Assistant
## English + Tamil with Natural Tamil Voice (gTTS)

---

## Why gTTS for Tamil?

| | pyttsx3 | gTTS (this version) |
|---|---|---|
| English voice | ✅ Natural | ✅ Natural |
| Tamil voice | ❌ Robotic / silent | ✅ Natural Google voice |
| Internet needed | ❌ No | ✅ Yes (Tamil only) |
| Speed | Fast | ~1 sec delay for Tamil |

**English** → pyttsx3 (offline, instant)
**Tamil** → gTTS (Google TTS, natural voice, needs internet)

---

## Install

### Mac
```bash
brew install portaudio mpg123
pip install -r requirements.txt
```

### Linux (Ubuntu/Debian)
```bash
sudo apt install portaudio19-dev mpg123
pip install -r requirements.txt
```

### Windows
```bash
pip install -r requirements.txt
# If pyaudio fails:
pip install pipwin
pipwin install pyaudio
```

---

## Run

```bash
python voice_assistant.py
```

---

## Switch language by voice

| Say | What happens |
|---|---|
| "Tamil" | Switches to Tamil — answers in Tamil voice |
| "Switch to Tamil" | Same |
| "English" | Switches back to English |
| "Switch to English" | Same |

---

## Files

```
labassist-gtts/
├── voice_assistant.py  ← MAIN FILE — run this
├── qa_data.py          ← All Q&A in English + Tamil
├── matcher.py          ← Bilingual keyword scorer
└── requirements.txt    ← 4 libraries
```

---

## How Tamil TTS works

```
Tamil answer text
      ↓
gTTS(text, lang="ta")   ← Google generates Tamil MP3
      ↓
Saved to temp .mp3 file
      ↓
Played via afplay (Mac) / mpg123 (Linux) / PowerShell (Windows)
      ↓
Temp file deleted
```

---

## Troubleshooting

**Tamil audio not playing on Linux:**
```bash
sudo apt install mpg123
# or
sudo apt install ffmpeg
```

**Tamil audio not playing on Mac:**
```bash
brew install mpg123
# afplay is built-in on Mac, should work automatically
```

**"No internet" error for Tamil:**
gTTS requires internet to generate Tamil audio.
English (pyttsx3) works offline.

**pyaudio install fails on Windows:**
```bash
pip install pipwin
pipwin install pyaudio
```
