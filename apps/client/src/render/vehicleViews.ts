/** Canvases in vehicle windows that show a small live view of their vehicle, by vehicle id. */
export const vehicleViews = new Map<HTMLCanvasElement, number>();

/** Canvases that show a small live view of a place (news previews), by map tile. */
export const placeViews = new Map<HTMLCanvasElement, number>();
