import type { Map as MapLibreMap } from 'maplibre-gl'
import {
  Box,
  Compass,
  Crop,
  LocateFixed,
  MapPin,
  Minus,
  PenLine,
  Pentagon,
  Plus,
  Redo2,
  Ruler,
  Spline,
  Undo2,
} from 'lucide-react'
import type { MeasureMode } from './store'
import { useT } from './i18n'
import { useAppStore } from './store'

interface MapHudProps {
  map: MapLibreMap | null
}

export function MapHud({ map }: MapHudProps) {
  const t = useT()
  const showToast = useAppStore((state) => state.showToast)
  const drawing = useAppStore((state) => state.drawing)
  const setDrawing = useAppStore((state) => state.setDrawing)
  const measureMode = useAppStore((state) => state.measureMode)
  const setMeasureMode = useAppStore((state) => state.setMeasureMode)
  const placingMarker = useAppStore((state) => state.placingMarker)
  const setPlacingMarker = useAppStore((state) => state.setPlacingMarker)
  const featureMode = useAppStore((state) => state.featureMode)
  const setFeatureMode = useAppStore((state) => state.setFeatureMode)
  const setPanel = useAppStore((state) => state.setPanel)
  const history = useAppStore((state) => state.history)
  const future = useAppStore((state) => state.future)
  const undo = useAppStore((state) => state.undo)
  const redo = useAppStore((state) => state.redo)

  const toggleDrawing = () => {
    if (drawing) {
      setDrawing(false)
      return
    }
    setDrawing(true)
    showToast(t('hud.selectHint'))
  }

  const toggleMeasure = (mode: Exclude<MeasureMode, null>) => {
    const next = measureMode === mode ? null : mode
    setMeasureMode(next)
    if (next === 'line') {
      showToast(t('hud.measureLine'))
    } else if (next === 'area') {
      showToast(t('hud.measureArea'))
    }
  }

  const toggleMarker = () => {
    setPlacingMarker(!placingMarker)
    setPanel('markers')
    if (!placingMarker) {
      showToast(t('hud.placeMarker'))
    }
  }

  const toggleFeature = (mode: 'draw-line' | 'draw-polygon') => {
    const state = useAppStore.getState()
    if (state.featureMode === mode) {
      const minimum = mode === 'draw-line' ? 2 : 3
      if (state.draftPoints.length >= minimum) state.finishDraft()
      else state.cancelDraft()
      return
    }
    setFeatureMode(mode)
    setPanel('features')
    showToast(
      mode === 'draw-line'
        ? t('hud.drawLine')
        : t('hud.drawPolygon'),
    )
  }

  const toggleEdit = () => {
    const next = featureMode === 'edit' ? 'off' : 'edit'
    setFeatureMode(next)
    setPanel('features')
    showToast(
      next === 'edit'
        ? t('hud.editHint')
        : t('hud.editOff'),
    )
  }

  return (
    <div className="map-hud" aria-label={t('hud.control')}>
      <div className="hud-group">
        <button
          type="button"
          className="hud-button"
          onClick={() => map?.zoomIn({ duration: 180 })}
          aria-label={t('hud.zoomIn')}
          title={t('hud.zoomIn')}
        >
          <Plus size={17} />
        </button>
        <button
          type="button"
          className="hud-button"
          onClick={() => map?.zoomOut({ duration: 180 })}
          aria-label={t('hud.zoomOut')}
          title={t('hud.zoomOut')}
        >
          <Minus size={17} />
        </button>
      </div>

      <div className="hud-group">
        <button
          type="button"
          className="hud-button"
          onClick={undo}
          disabled={history.length === 0}
          aria-label={t('hud.undo')}
          title={`${t('hud.undo')} (Ctrl+Z)`}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className="hud-button"
          onClick={redo}
          disabled={future.length === 0}
          aria-label={t('hud.redo')}
          title={`${t('hud.redo')} (Ctrl+Shift+Z)`}
        >
          <Redo2 size={16} />
        </button>
      </div>

      <div className="hud-group">
        <button
          type="button"
          className="hud-button"
          onClick={() =>
            map?.easeTo({ bearing: 0, pitch: 0, duration: 250 })
          }
          aria-label={t('hud.north')}
          title={t('hud.north')}
        >
          <Compass size={17} />
        </button>
        <button
          type="button"
          className="hud-button"
          onClick={() => showToast(t('hud.positionSoon'))}
          aria-label={t('hud.position')}
          title={t('hud.positionSoon')}
        >
          <LocateFixed size={17} />
        </button>
      </div>

      <div className="hud-group">
        <button
          type="button"
          className={`hud-button${measureMode === 'line' ? ' is-active' : ''}`}
          onClick={() => toggleMeasure('line')}
          aria-label={t('hud.ruler')}
          aria-pressed={measureMode === 'line'}
          title={`${t('hud.ruler')} (M)`}
        >
          <Ruler size={16} />
        </button>
        <button
          type="button"
          className={`hud-button${measureMode === 'area' ? ' is-active' : ''}`}
          onClick={() => toggleMeasure('area')}
          aria-label={t('hud.area')}
          aria-pressed={measureMode === 'area'}
          title={`${t('hud.area')} (Shift+M)`}
        >
          <Pentagon size={16} />
        </button>
        <button
          type="button"
          className={`hud-button${placingMarker ? ' is-active' : ''}`}
          onClick={toggleMarker}
          aria-label={t('hud.marker')}
          aria-pressed={placingMarker}
          title={`${t('hud.marker')} (P)`}
        >
          <MapPin size={16} />
        </button>
        <button
          type="button"
          className={`hud-button${featureMode === 'draw-line' ? ' is-active' : ''}`}
          onClick={() => toggleFeature('draw-line')}
          aria-label={t('hud.line')}
          aria-pressed={featureMode === 'draw-line'}
          title={`${t('hud.line')} (L)`}
        >
          <Spline size={16} />
        </button>
        <button
          type="button"
          className={`hud-button${featureMode === 'draw-polygon' ? ' is-active' : ''}`}
          onClick={() => toggleFeature('draw-polygon')}
          aria-label={t('hud.polygon')}
          aria-pressed={featureMode === 'draw-polygon'}
          title={`${t('hud.polygon')} (Shift+L)`}
        >
          <Pentagon size={16} />
        </button>
        <button
          type="button"
          className={`hud-button${featureMode === 'edit' ? ' is-active' : ''}`}
          onClick={toggleEdit}
          aria-label={t('hud.edit')}
          aria-pressed={featureMode === 'edit'}
          title={`${t('hud.edit')} (E)`}
        >
          <PenLine size={16} />
        </button>
      </div>

      <button
        type="button"
        className={`hud-button hud-button-wide${drawing ? ' is-active' : ''}`}
        onClick={toggleDrawing}
        aria-label={drawing ? t('hud.cancelSelection') : t('hud.select')}
        aria-pressed={drawing}
        title={`${t('hud.select')} (R)`}
      >
        <Crop size={15} />
        {drawing ? t('hud.cancel') : t('hud.district')}
      </button>

      <button
        type="button"
        className="hud-button hud-button-wide"
        onClick={() => showToast('3D — after 1.0')}
        aria-label={t('hud.3d')}
        title={t('hud.3d')}
      >
        <Box size={16} />
        3D
      </button>
    </div>
  )
}
