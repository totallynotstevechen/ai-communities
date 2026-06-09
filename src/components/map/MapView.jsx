import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import { useApp } from '../../context/AppContext'
import { PRIORITY_COLORS } from '../../utils/constants'

export default function MapView() {
  const { filtered, filters, selectedId, showCommunities, dispatch } = useApp()
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(null)
  const markersByIdRef = useRef(new Map())
  const navListRef = useRef([])
  const viewportListRef = useRef([])
  const selectedIdRef = useRef(selectedId)
  const popupOpenIdRef = useRef(null)
  const clearControlRef = useRef(null)

  // Keep a ref of the current selectedId so click/keyboard handlers see the latest value
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  // Recompute the subset of navListRef pins that fall within the current map bounds.
  // Preserves navListRef's sort order by filtering in-place.
  const recomputeViewportList = () => {
    const map = mapRef.current
    if (!map) { viewportListRef.current = []; return }
    const bounds = map.getBounds()
    const next = []
    for (const id of navListRef.current) {
      const m = markersByIdRef.current.get(id)
      if (m && bounds.contains(m.getLatLng())) next.push(id)
    }
    viewportListRef.current = next
  }

  // Patch the counter text + nav row visibility inside the currently open popup.
  // Off-viewport current pin drops the index and shows only "N in view".
  const updateOpenPopupCounter = () => {
    const openId = popupOpenIdRef.current
    if (!openId) return
    const marker = markersByIdRef.current.get(openId)
    const popupEl = marker?.getPopup?.()?.getElement?.()
    if (!popupEl) return
    const navRow = popupEl.querySelector('[data-nav-row]')
    if (!navRow) return
    const list = viewportListRef.current
    if (list.length < 2) { navRow.style.display = 'none'; return }
    navRow.style.display = 'flex'
    const counter = popupEl.querySelector('[data-nav-counter]')
    if (!counter) return
    const idx = list.indexOf(openId)
    counter.textContent = idx >= 0
      ? `${idx + 1} of ${list.length} in view`
      : `${list.length} in view`
  }

  // Imperatively navigate popups between pins. Used by popup prev/next and keyboard arrows.
  // Does NOT dispatch SELECT — popup nav is kept independent of the detail sheet.
  const navigateToPin = (id) => {
    const map = mapRef.current
    const cluster = markersRef.current
    const marker = markersByIdRef.current.get(id)
    if (!map || !marker) return
    map.closePopup()
    const open = () => marker.openPopup()
    if (cluster && typeof cluster.zoomToShowLayer === 'function' && !marker._icon) {
      cluster.zoomToShowLayer(marker, open)
      return
    }
    const latLng = marker.getLatLng()
    const zoom = Math.max(map.getZoom(), 6)
    map.flyTo(latLng, zoom, { duration: 0.5 })
    map.once('moveend', open)
  }

  // Initialize map once
  useEffect(() => {
    if (mapRef.current) return

    const map = L.map(containerRef.current, {
      center: [35, 0],
      zoom: 3,
      minZoom: 2,
      maxZoom: 15,
      zoomControl: false,
    })

    L.control.zoom({ position: 'bottomright' }).addTo(map)

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)

    mapRef.current = map
    markersRef.current = L.markerClusterGroup({
      maxClusterRadius: 30,
      disableClusteringAtZoom: 10,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      chunkedLoading: true,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount()
        const size = n < 10 ? 32 : n < 50 ? 38 : 44
        return L.divIcon({
          html: `<div style="background:#3b82f6;color:#fff;border-radius:50%;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font:600 12px system-ui,-apple-system,sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.25)">${n}</div>`,
          className: 'custom-cluster',
          iconSize: L.point(size, size),
        })
      },
    }).addTo(map)

    // One listener covers pan + zoom. moveend fires once per gesture, so no debouncing needed.
    map.on('moveend', () => {
      recomputeViewportList()
      updateOpenPopupCounter()
    })

    return () => { map.remove(); mapRef.current = null }
  }, [])

  // Build markers when data or visibility changes. Selection styling is applied in a separate effect.
  useEffect(() => {
    const map = mapRef.current
    const layer = markersRef.current
    if (!map || !layer) return

    layer.clearLayers()
    markersByIdRef.current.clear()
    navListRef.current = []
    viewportListRef.current = []
    // Popup was attached to a marker we just destroyed; drop the stale id so arrow
    // nav can't act on it if Leaflet's popupclose doesn't fire synchronously.
    popupOpenIdRef.current = null

    if (!filtered.length) return

    // Order pins the same way Sidebar does: priority desc, then name asc. Pin without coords is skipped.
    const visible = (showCommunities ? filtered : filtered.filter(c => c.events.length > 0))
      .filter(c => c.lat != null && c.lng != null)
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))

    navListRef.current = visible.map(c => c.id)
    const bounds = []

    for (let i = 0; i < visible.length; i++) {
      const c = visible[i]
      const p = PRIORITY_COLORS[c.priority] || PRIORITY_COLORS[0]
      const isSelected = c.id === selectedIdRef.current
      const radius = c.priority >= 3 ? 8 : c.priority >= 1 ? 6 : 4.5

      const marker = L.circleMarker([c.lat, c.lng], {
        radius: isSelected ? radius + 3 : radius,
        fillColor: p.fill,
        color: isSelected ? '#1d4ed8' : '#fff',
        weight: isSelected ? 2.5 : 1.5,
        opacity: 1,
        fillOpacity: isSelected ? 1 : 0.75,
      })

      // Stats line: last event attendees if available, otherwise member count
      let statsLine = ''
      if (c.attendanceEstimate) {
        statsLine = `<span style="font-weight:600;color:#374151">${c.attendanceEstimate.toLocaleString()}+</span> last event attendees`
      } else if (c.memberCount) {
        statsLine = `<span style="font-weight:600;color:#374151">${c.memberCount.toLocaleString()}</span> members`
      }

      const siblingCount = filtered.filter(s =>
        s.id !== c.id && (c.isGrouped ? s.groupName === c.groupName : s.regionId === c.regionId)
      ).length
      const siblingLine = siblingCount > 0
        ? `<div style="font-size:10px;color:#9ca3af;margin-bottom:6px">${siblingCount} related group${siblingCount > 1 ? 's' : ''} nearby</div>`
        : ''
      const nextEvent = Array.isArray(c.events) ? c.events.find((ev) => ev?.date) : null
      let nextEventLine = ''
      if (nextEvent) {
        const d = new Date(nextEvent.date + 'T12:00:00')
        const formatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        nextEventLine = `<div style="font-size:11px;color:#4b5563;margin-bottom:6px"><strong>Next:</strong> ${formatted}</div>`
      }
      const nextEventLink = nextEvent?.url
        ? `<a href="${nextEvent.url}" target="_blank" rel="noopener" style="font-size:11px;color:#3b82f6;text-decoration:none">Visit Upcoming Event &rarr;</a>`
        : ''

      // Nav row is always emitted but starts hidden; updateOpenPopupCounter() fills in the
      // counter text and toggles visibility based on the current viewport list size.
      const navRow = `<div data-nav-row style="display:none;justify-content:space-between;align-items:center;margin:-4px -4px 6px;font-size:10px;color:#9ca3af">
            <button type="button" data-nav="prev" aria-label="Previous community" style="background:transparent;border:0;padding:2px 8px;cursor:pointer;color:#3b82f6;font-size:13px;line-height:1;font-weight:600">&#9664;</button>
            <span data-nav-counter></span>
            <button type="button" data-nav="next" aria-label="Next community" style="background:transparent;border:0;padding:2px 8px;cursor:pointer;color:#3b82f6;font-size:13px;line-height:1;font-weight:600">&#9654;</button>
          </div>`

      marker.bindPopup(`
        <div style="font-family:system-ui,-apple-system,sans-serif;min-width:200px;max-width:280px">
          ${navRow}
          <div style="font-weight:600;font-size:13px;line-height:1.3;margin-bottom:2px">
            ${c.name}
          </div>
          ${statsLine ? `<div style="display:inline-block;font-size:11px;color:#6b7280;margin-bottom:6px">${statsLine}</div>` : ''}
          ${siblingLine}
          ${nextEventLine}
          <div style="color:#6b7280;font-size:11px;line-height:1.4;margin-bottom:8px">
            ${c.description.slice(0, 120)}${c.description.length > 120 ? '...' : ''}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;row-gap:4px;align-items:center">
            ${c.url ? `<a href="${c.url}" target="_blank" rel="noopener" style="font-size:11px;color:#3b82f6;text-decoration:none">Visit Community &rarr;</a>` : ''}
            ${nextEventLink}
            <a href="#" data-detail-id="${c.id}" style="font-size:11px;color:#3b82f6;text-decoration:none;cursor:pointer">See More details &rarr;</a>
          </div>
        </div>
      `, { maxWidth: 300, className: 'clean-popup' })

      marker.on('popupopen', () => {
        popupOpenIdRef.current = c.id
        updateOpenPopupCounter()
      })
      marker.on('popupclose', () => {
        if (popupOpenIdRef.current === c.id) popupOpenIdRef.current = null
      })

      marker.addTo(layer)
      markersByIdRef.current.set(c.id, marker)
      bounds.push([c.lat, c.lng])
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 })
    }

    // Seed the viewport list. fitBounds triggers moveend which also recomputes,
    // but filter changes that don't move the map wouldn't fire moveend otherwise.
    recomputeViewportList()

    // Delegated click handler for popup links.
    // Prev/next nav is imperative (closes + opens popups) so it doesn't trigger the detail sheet.
    // "See More details" dispatches SELECT to open the sheet.
    const handler = (e) => {
      const navBtn = e.target.closest('[data-nav]')
      if (navBtn) {
        e.preventDefault()
        const list = viewportListRef.current
        if (list.length < 2) return
        const dir = navBtn.dataset.nav
        const cur = list.indexOf(popupOpenIdRef.current)
        const idx = cur >= 0
          ? (cur + (dir === 'next' ? 1 : -1) + list.length) % list.length
          : (dir === 'next' ? 0 : list.length - 1)
        navigateToPin(list[idx])
        return
      }
      const link = e.target.closest('[data-detail-id]')
      if (link) {
        e.preventDefault()
        map.closePopup()
        dispatch({ type: 'SELECT', id: link.dataset.detailId })
      }
    }
    map.getContainer().addEventListener('click', handler)
    return () => map.getContainer().removeEventListener('click', handler)
  }, [filtered, showCommunities, dispatch])

  // Apply selected styling (bigger radius, blue ring) without rebuilding markers
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersByIdRef.current.forEach((marker, id) => {
      const c = filtered.find(x => x.id === id)
      if (!c) return
      const p = PRIORITY_COLORS[c.priority] || PRIORITY_COLORS[0]
      const baseRadius = c.priority >= 3 ? 8 : c.priority >= 1 ? 6 : 4.5
      const isSelected = id === selectedId
      marker.setStyle({
        radius: isSelected ? baseRadius + 3 : baseRadius,
        fillColor: p.fill,
        color: isSelected ? '#1d4ed8' : '#fff',
        weight: isSelected ? 2.5 : 1.5,
        opacity: 1,
        fillOpacity: isSelected ? 1 : 0.75,
      })
    })
  }, [selectedId, filtered])

  // Pan to the pin whose details are showing. Shift the target upward in pixel space
  // so the pin sits above the bottom-sheet (which covers ~55% of the map height).
  useEffect(() => {
    const map = mapRef.current
    const clusterGroup = markersRef.current
    if (!map) return
    if (!selectedId) { map.closePopup(); return }
    const marker = markersByIdRef.current.get(selectedId)
    if (!marker) return
    map.closePopup()
    const panWithOffset = () => {
      const zoom = Math.max(map.getZoom(), 6)
      const sheetPx = map.getSize().y * 0.55
      const pt = map.project(marker.getLatLng(), zoom)
      pt.y += sheetPx / 2 // move camera target down so pin appears up
      map.flyTo(map.unproject(pt, zoom), zoom, { duration: 0.5 })
    }
    // If clustered, let markercluster un-cluster first; once it's done the pin is visible.
    if (clusterGroup && typeof clusterGroup.zoomToShowLayer === 'function' && !marker._icon) {
      clusterGroup.zoomToShowLayer(marker, panWithOffset)
      return
    }
    panWithOffset()
  }, [selectedId, filtered])

  // Keyboard: Arrow keys navigate pin popup; Escape closes sheet first, else closes popup.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && typeof t.matches === 'function' && t.matches('input, textarea, [contenteditable="true"]')) return
      if (e.key === 'Escape') {
        if (selectedIdRef.current) {
          e.preventDefault()
          dispatch({ type: 'DESELECT' })
          return
        }
        if (popupOpenIdRef.current) {
          e.preventDefault()
          mapRef.current?.closePopup()
        }
        return
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (!popupOpenIdRef.current) return
      const list = viewportListRef.current
      if (list.length < 2) return
      e.preventDefault()
      const cur = list.indexOf(popupOpenIdRef.current)
      const idx = cur >= 0
        ? (cur + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length
        : (e.key === 'ArrowRight' ? 0 : list.length - 1)
      navigateToPin(list[idx])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch])

  // Clear Filters control on map
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const hasFilters = filters.search || filters.regions.length || filters.priorities.length

    if (hasFilters && !clearControlRef.current) {
      const ClearControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
          const btn = L.DomUtil.create('button', '')
          btn.innerHTML = '✕ Clear Filters'
          btn.style.cssText = 'background:#34d399;border:1px solid #34d399;border-radius:8px;padding:5px 12px;font-size:12px;color:#fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.1);font-family:system-ui,sans-serif;font-weight:500'
          btn.onmouseenter = () => { btn.style.background = '#10b981'; btn.style.borderColor = '#10b981' }
          btn.onmouseleave = () => { btn.style.background = '#34d399'; btn.style.borderColor = '#34d399' }
          L.DomEvent.disableClickPropagation(btn)
          btn.onclick = () => dispatch({ type: 'CLEAR_FILTERS' })
          return btn
        },
      })
      clearControlRef.current = new ClearControl()
      clearControlRef.current.addTo(map)
    } else if (!hasFilters && clearControlRef.current) {
      map.removeControl(clearControlRef.current)
      clearControlRef.current = null
    }
  }, [filters, dispatch])

  return <div ref={containerRef} className="h-full w-full" />
}
