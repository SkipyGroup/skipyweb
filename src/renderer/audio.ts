export {}

type AudioBridge = {
  onStart(callback: (db: number, frequency: number, muted: boolean) => void): void
  onUpdate(callback: (db: number, frequency: number, muted: boolean) => void): void
  onStop(callback: () => void): void
  status(kind: 'active' | 'error', message?: string): void
}
declare global { interface Window { skipyAudio: AudioBridge } }

let stream: MediaStream | null = null
let context: AudioContext | null = null
let highpass: BiquadFilterNode | null = null
let shelf: BiquadFilterNode | null = null
let peak: BiquadFilterNode | null = null
let output: GainNode | null = null
let starting = false
function outputLevel(db: number, muted: boolean) { return muted ? 0 : Math.pow(10, -Math.max(0, db - 2) * 0.52 / 20) }

async function stop() {
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  output?.disconnect()
  highpass?.disconnect()
  shelf?.disconnect()
  peak?.disconnect()
  output = null
  highpass = null
  shelf = null
  peak = null
  if (context) await context.close().catch(() => undefined)
  context = null
}

window.skipyAudio.onStart(async (db, frequency, muted) => {
  if (starting) return
  starting = true
  const timeout = setTimeout(() => window.skipyAudio.status('error', 'A hangrögzítés nem indult el időben.'), 8000)
  await stop()
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    stream.getVideoTracks().forEach(track => track.stop())
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error('Nincs hangcsatorna a lapon.')
    context = new AudioContext()
    highpass = context.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 25
    highpass.Q.value = 0.7
    shelf = context.createBiquadFilter()
    shelf.type = 'lowshelf'
    shelf.frequency.value = frequency
    shelf.gain.value = db
    peak = context.createBiquadFilter()
    peak.type = 'peaking'
    peak.frequency.value = Math.max(45, frequency * 0.72)
    peak.Q.value = 0.8
    peak.gain.value = db * 0.18
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -1.5
    compressor.knee.value = 1
    compressor.ratio.value = 18
    compressor.attack.value = 0.002
    compressor.release.value = 0.12
    output = context.createGain()
    output.gain.value = outputLevel(db, muted)
    context.createMediaStreamSource(stream).connect(highpass).connect(shelf).connect(peak).connect(compressor).connect(output).connect(context.destination)
    await context.resume()
    track.addEventListener('ended', () => { void stop(); window.skipyAudio.status('error', 'A lap hangrögzítése megszakadt.') }, { once: true })
    window.skipyAudio.status('active')
  } catch (error) {
    await stop()
    window.skipyAudio.status('error', error instanceof Error ? error.message : 'A hangrögzítés nem sikerült.')
  } finally { clearTimeout(timeout); starting = false }
})
window.skipyAudio.onUpdate((db, frequency, muted) => {
  if (shelf && context) {
    shelf.gain.setTargetAtTime(db, context.currentTime, 0.045)
    shelf.frequency.setTargetAtTime(frequency, context.currentTime, 0.045)
  }
  if (peak && context) {
    peak.frequency.setTargetAtTime(Math.max(45, frequency * 0.72), context.currentTime, 0.045)
    peak.gain.setTargetAtTime(db * 0.18, context.currentTime, 0.045)
  }
  if (output && context) output.gain.setTargetAtTime(outputLevel(db, muted), context.currentTime, 0.01)
})
window.skipyAudio.onStop(() => { void stop() })
