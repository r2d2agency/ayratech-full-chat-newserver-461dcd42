// Geofence utilities: polygon (ray casting) + radius (haversine) validation.

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// polygon: [{lat, lng}, ...] (>=3 points). Point-in-polygon by ray casting.
function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i].lng), yi = Number(polygon[i].lat);
    const xj = Number(polygon[j].lng), yj = Number(polygon[j].lat);
    if (!isFinite(xi) || !isFinite(yi) || !isFinite(xj) || !isFinite(yj)) continue;
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Distance from point to polygon centroid (approximate min distance for messaging).
function distanceToPolygonCentroid(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  let sx = 0, sy = 0, n = 0;
  for (const p of polygon) {
    const la = Number(p.lat), ln = Number(p.lng);
    if (isFinite(la) && isFinite(ln)) { sy += la; sx += ln; n++; }
  }
  if (!n) return null;
  return haversineMeters(lat, lng, sy / n, sx / n);
}

/**
 * Validate a promoter/employee position against a PDV.
 * Prefer polygon if present; fall back to radius. Missing coords -> unknown (allowed).
 * @returns {{ status:'inside'|'outside'|'unknown', mode:'polygon'|'radius'|'none', distance:number|null }}
 */
function validatePdvLocation({ userLat, userLng, pdvLat, pdvLng, radiusMeters, polygon }) {
  const uLat = Number(userLat), uLng = Number(userLng);
  const hasUser = isFinite(uLat) && isFinite(uLng);
  const pLat = Number(pdvLat), pLng = Number(pdvLng);
  const hasPdvCenter = isFinite(pLat) && isFinite(pLng);

  if (Array.isArray(polygon) && polygon.length >= 3) {
    if (!hasUser) return { status: 'unknown', mode: 'polygon', distance: null };
    const inside = pointInPolygon(uLat, uLng, polygon);
    const distance = distanceToPolygonCentroid(uLat, uLng, polygon);
    if (inside) return { status: 'inside', mode: 'polygon', distance };
    // Fallback: o raio cadastrado (a partir do centro do PDV) funciona como
    // tolerância extra — cobre imprecisão no desenho manual do polígono
    // (ex.: imagem de satélite desalinhada) sem exigir redesenhar o perímetro.
    if (hasPdvCenter) {
      const radius = Number(radiusMeters) > 0 ? Number(radiusMeters) : 200;
      const radiusDistance = haversineMeters(uLat, uLng, pLat, pLng);
      if (radiusDistance <= radius) {
        return { status: 'inside', mode: 'radius', distance: radiusDistance };
      }
    }
    return { status: 'outside', mode: 'polygon', distance };
  }

  if (!hasPdvCenter) {
    return { status: 'unknown', mode: 'none', distance: null };
  }
  if (!hasUser) return { status: 'unknown', mode: 'radius', distance: null };
  const distance = haversineMeters(uLat, uLng, pLat, pLng);
  const radius = Number(radiusMeters) > 0 ? Number(radiusMeters) : 200;
  return { status: distance <= radius ? 'inside' : 'outside', mode: 'radius', distance };
}

async function ensurePdvGeofenceColumn(query) {
  try {
    await query(`ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS geofence_polygon JSONB`);
  } catch (_) { /* ignore */ }
}

export {
  haversineMeters,
  pointInPolygon,
  validatePdvLocation,
  ensurePdvGeofenceColumn,
};
