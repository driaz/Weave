export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

const MAX_BASE64_BYTES = 4 * 1024 * 1024 // 4MB
const MAX_DIMENSION = 1500
const JPEG_QUALITY = 0.8

/**
 * Compresses a base64 data URL if it exceeds 4MB.
 * Scales the image down proportionally so the longest dimension is max 1500px,
 * then re-encodes as JPEG at 0.8 quality.
 * Returns the original data URL if already under the size limit.
 */
export function compressBase64Image(dataUrl: string): Promise<string> {
  // Check raw base64 size (strip the data:...;base64, prefix)
  const commaIndex = dataUrl.indexOf(',')
  const base64Data = commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : dataUrl
  const byteSize = base64Data.length * 0.75 // base64 → bytes approximation

  if (byteSize <= MAX_BASE64_BYTES) {
    return Promise.resolve(dataUrl)
  }

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img

      // Scale down proportionally so longest side ≤ MAX_DIMENSION
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Could not get canvas 2d context'))
        return
      }

      ctx.drawImage(img, 0, 0, width, height)
      const compressed = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
      resolve(compressed)
    }
    img.onerror = () => reject(new Error('Failed to load image for compression'))
    img.src = dataUrl
  })
}
