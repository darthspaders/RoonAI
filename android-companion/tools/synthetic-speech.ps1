param([string]$OutputDirectory = "$PSScriptRoot/../build/synthetic-speech")
# Run with Windows PowerShell 5.1. Produces local test audio; never records a microphone.
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$samples = @('Hey Synapse. Skip this track.', 'Hey Synapse. What is playing?', 'Hey Synapse. Queue ten standby tracks.', 'Hey Synapse. Cancel.', 'The weather looks nice today.', 'Play music from the other room.')
for ($i = 0; $i -lt $samples.Count; $i++) {
    $speaker.SetOutputToWaveFile((Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) "sample-$i.wav"), $format)
    $speaker.Speak($samples[$i])
    $speaker.SetOutputToNull()
}
$speaker.Dispose()
