/** Custom marker icons are rasterized to small PNG data URLs. */

const SUPPORTED = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const ICON_SIZE = 64

export const MAX_ICON_DATA_URL = 64 * 1024

/** Crops and scales a user image into a compact square PNG data URL. */
export async function readMarkerIcon(file: File): Promise<string> {
  if (!SUPPORTED.has(file.type)) {
    throw new Error('PNG, JPEG, WebP or GIF expected')
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('image is larger than 2 MB')
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('image could not be decoded'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = ICON_SIZE
    canvas.height = ICON_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas is unavailable')
    const scale = Math.min(
      ICON_SIZE / image.naturalWidth,
      ICON_SIZE / image.naturalHeight,
    )
    const width = image.naturalWidth * scale
    const height = image.naturalHeight * scale
    context.drawImage(
      image,
      (ICON_SIZE - width) / 2,
      (ICON_SIZE - height) / 2,
      width,
      height,
    )
    const dataUrl = canvas.toDataURL('image/png')
    if (dataUrl.length > MAX_ICON_DATA_URL) {
      throw new Error('image is too complex')
    }
    return dataUrl
  } finally {
    URL.revokeObjectURL(url)
  }
}
