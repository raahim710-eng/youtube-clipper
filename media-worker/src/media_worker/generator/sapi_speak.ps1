param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutWav,
  [string]$Voice = "",
  [int]$Rate = 0,
  [switch]$ListVoices
)
# Windows' built-in speech engine (System.Speech / SAPI 5). Writes 16 kHz mono WAV and prints JSON with the
# start time of every word. Word positions are only exact at 16 kHz, which is why that format is fixed here.
# Text is read from a UTF-8 file (never passed on the command line).
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
      @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = $_.VoiceInfo.Gender.ToString() }
    })
  if ($ListVoices) {
    @{ voices = $voices } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }
  if ($Voice) { $synth.SelectVoice($Voice) }
  $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutWav, $format)
  $words = New-Object System.Collections.ArrayList
  $synth.add_SpeakProgress({ param($sender, $e)
      [void]$words.Add(@{ ms = [int]$e.AudioPosition.TotalMilliseconds; text = $e.Text })
    })
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  $synth.Speak($text)
  $synth.SetOutputToNull()
  @{ voice = $synth.Voice.Name; words = @($words) } | ConvertTo-Json -Depth 4 -Compress
}
finally {
  $synth.Dispose()
}
