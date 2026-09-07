"""Desktop smoke test of the same bundled Vosk model; not a tablet accuracy benchmark."""
import json
import pathlib
import wave
import vosk

root = pathlib.Path(__file__).resolve().parent.parent
vosk.SetLogLevel(-1)
model = vosk.Model(str(root / "app/src/main/assets/model"))
assert all(model.vosk_model_find_word(w) >= 0 for w in ["hey", "synapse"])
reports = []
for index, file in enumerate(sorted((root / "build/synthetic-speech").glob("*.wav"))):
    wake = vosk.KaldiRecognizer(model, 16000, json.dumps(["hey synapse", "[unk]"]))
    wake.SetWords(True)
    wake.SetPartialWords(True)
    speech = vosk.KaldiRecognizer(model, 16000)
    triggered = False
    accepted = 0
    segments = []
    with wave.open(str(file), "rb") as audio:
        data = audio.readframes(audio.getnframes()) + bytes(16000 * 2 * 2)
    for offset in range(0, len(data), 3200):
        block = data[offset:offset + 3200]
        if not triggered:
            accepted += len(block)
            full = wake.AcceptWaveform(block)
            result = json.loads(wake.Result() if full else wake.PartialResult())
            if "hey synapse" in result.get("text" if full else "partial", ""):
                ends = [w["end"] for w in result.get("result" if full else "partial_result", []) if w["word"] == "synapse"]
                if ends:
                    trailing = max(0, min(96000, accepted - int(ends[-1] * 32000))) // 2 * 2
                    triggered = True
                    if trailing: speech.AcceptWaveform(data[offset + len(block) - trailing:offset + len(block)])
            if full and not triggered: wake.Reset(); accepted = 0
        elif speech.AcceptWaveform(block):
            segments.append(json.loads(speech.Result())["text"])
    segments.append(json.loads(speech.FinalResult())["text"])
    report = {"file": file.name, "wakeDetected": triggered, "expectedWake": index < 4, "command": " ".join(s for s in segments if s)}
    reports.append(report)
print(json.dumps(reports, indent=2))
assert len(reports) == 6
assert all(r["wakeDetected"] == r["expectedWake"] for r in reports)
assert reports[0]["command"] == "skip this track"
assert reports[1]["command"] == "what is playing"
assert reports[3]["command"] == "cancel"
