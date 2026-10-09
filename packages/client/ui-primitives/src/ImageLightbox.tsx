import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutlineRegular, IconDownloadOutlineRegular } from './icons/index.tsx'
import css from './ImageLightbox.module.css'

/** Lightbox strings the owner resolves from its own locale namespace. */
export interface ImageLightboxLabels {
  /** Accessible name of the preview dialog. */
  dialog: string
  /** Accessible label of the close control. */
  close: string
  /** Visible label of the image download control. */
  save?: string
}

/**
 * Document-level original-image preview opened by clicking a thumbnail.
 * Closes on Escape, backdrop press, or the close control, and restores focus
 * to the opener on unmount. Rendered through a body portal: an opener inside
 * a transformed or filtered ancestor would otherwise trap the fixed backdrop
 * in that ancestor's box instead of covering the viewport.
 *
 * @param props.src - the original image URL.
 * @param props.alt - the image's alt text.
 * @param props.labels - dialog and close-control strings.
 * @param props.onClose - dismiss callback owned by the opener.
 * @returns the modal preview dialog.
 */
export function ImageLightbox({ src, alt, labels, downloadName = 'image.png', onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  downloadName?: string
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const saveRef = useRef<HTMLAnchorElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key === 'Tab') {
        const controls: HTMLElement[] = []
        if (closeRef.current !== null) controls.push(closeRef.current)
        if (saveRef.current !== null) controls.push(saveRef.current)
        if (controls.length < 2) { event.preventDefault(); controls[0]?.focus(); return }
        const current = controls.indexOf(document.activeElement as HTMLElement)
        const step = event.shiftKey ? -1 : 1
        controls[(current + step + controls.length) % controls.length]?.focus()
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      restoreRef.current?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className={css.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={labels.dialog}
    >
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img className={css.image} src={src} alt={alt} />
      {labels.save !== undefined && (
        <a
          ref={saveRef}
          className={css.save}
          href={src}
          download={downloadName}
          aria-label={labels.save}
          title={labels.save}
          onMouseDown={(event) => { event.stopPropagation() }}
        >
          <IconDownloadOutlineRegular size={16} />
          <span>{labels.save}</span>
        </a>
      )}
      <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutlineRegular size={16} />
      </button>
    </div>,
    document.body,
  )
}
