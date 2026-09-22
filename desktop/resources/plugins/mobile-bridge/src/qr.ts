/**
 * QR rendering for the pairing link.
 *
 * The bridge ships inside the desktop app, so it must not add a runtime
 * dependency to the engine's installation: the MIT-licensed `qrcode-generator`
 * (Kazuhiko Arase) is vendored under `vendor/qrcode.cjs` and resolved through
 * `createRequire`. The desktop shell uses the same library for its own card, so
 * both render an identical QR for a given link.
 *
 * @module @dsh-desktop/dsh-mobile-bridge/qr
 */

import { createRequire } from 'node:module'

interface QrCode {
  addData(data: string): void
  make(): void
  createSvgTag(options: { cellSize: number; margin: number; scalable: boolean }): string
}

type QrFactory = (typeNumber: number, errorCorrectionLevel: string) => QrCode

const requireVendor = createRequire(import.meta.url)
let factory: QrFactory | null = null

/**
 * Resolve the vendored library lazily: a missing vendor file must surface as a
 * readable request failure, not as a plugin that refuses to load.
 */
function qrFactory(): QrFactory {
  if (factory === null) {
    const loaded = requireVendor('../vendor/qrcode.cjs') as QrFactory | { default?: QrFactory }
    factory = typeof loaded === 'function' ? loaded : (loaded.default as QrFactory)
  }
  return factory
}

/** Inline SVG for `payload`. Cell size 4 / margin 2 stays scannable at card width. */
export function qrSvg(payload: string): string {
  const qr = qrFactory()(0, 'M')
  qr.addData(payload)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}
