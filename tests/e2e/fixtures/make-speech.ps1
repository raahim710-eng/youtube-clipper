param([Parameter(Mandatory = $true)][string]$OutWav, [string]$TextFile)
# Synthesises real spoken audio with the Windows built-in speech engine (System.Speech / SAPI).
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($OutWav, $format)
$text = Get-Content -Raw -Path $TextFile
$synth.Speak($text)
$synth.Dispose()
Write-Output "wrote $OutWav"
