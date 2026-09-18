function installFingerprint(seed: number, enabled: boolean) {
  if (!enabled) return
  const offset = seed % 3
  const delta = (seed & 1) ? 1 : -1
  function change(bytes: Uint8ClampedArray | Uint8Array) {
    if (bytes.length < 4) return
    const pixelCount = Math.floor(bytes.length / 4)
    const index = ((seed >>> 8) % pixelCount) * 4 + offset
    bytes[index] = (bytes[index] + delta + 256) % 256
  }

  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData
  CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof originalGetImageData>) {
    const result = originalGetImageData.apply(this, args)
    change(result.data)
    return result
  }

  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL
  const originalToBlob = HTMLCanvasElement.prototype.toBlob
  function copiedCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
    if (!source.width || !source.height) return null
    try {
      const copy = document.createElement('canvas')
      copy.width = source.width; copy.height = source.height
      const context = copy.getContext('2d')
      if (!context) return null
      context.drawImage(source, 0, 0)
      const pixels = originalGetImageData.call(context, 0, 0, copy.width, copy.height)
      change(pixels.data)
      context.putImageData(pixels, 0, 0)
      return copy
    } catch { return null }
  }
  HTMLCanvasElement.prototype.toDataURL = function (...args: Parameters<typeof originalToDataURL>) {
    return originalToDataURL.apply(copiedCanvas(this) || this, args)
  }
  HTMLCanvasElement.prototype.toBlob = function (...args: Parameters<typeof originalToBlob>) {
    return originalToBlob.apply(copiedCanvas(this) || this, args)
  }

  const renderers = [
    ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics, D3D11)'],
    ['Google Inc. (AMD)', 'ANGLE (AMD, Radeon Graphics, D3D11)'],
    ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, GeForce Graphics, D3D11)'],
  ]
  function patchWebGL(proto: typeof WebGLRenderingContext.prototype | typeof WebGL2RenderingContext.prototype) {
    const originalReadPixels = proto.readPixels
    const originalGetParameter = proto.getParameter
    proto.readPixels = function (this: WebGLRenderingContext | WebGL2RenderingContext, ...args: Parameters<typeof originalReadPixels>) {
      const result = Reflect.apply(originalReadPixels, this, args)
      const pixels = args[6]
      if (ArrayBuffer.isView(pixels) && pixels.byteLength >= 4) {
        const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
        change(bytes)
      }
      return result
    } as typeof originalReadPixels
    proto.getParameter = function (this: WebGLRenderingContext | WebGL2RenderingContext, parameter: number) {
      const value = originalGetParameter.call(this, parameter)
      if (typeof value !== 'string') return value
      if (parameter === 37445) return renderers[seed % renderers.length][0]
      if (parameter === 37446) return renderers[seed % renderers.length][1]
      return value
    }
  }
  if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext.prototype)
  if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype)
}
