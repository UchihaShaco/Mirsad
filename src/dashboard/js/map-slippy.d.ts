/** Types for map-slippy.js (the browser loads the JavaScript; tests and typecheck read this declaration). */
export const TILE_SIZE: 256;
export const MAX_LAT: 85.05112878;
export function clampLat(lat: number): number;
export function wrapLon(lon: number): number;
export function project(lon: number, lat: number, zoom: number): { x: number; y: number };
export function unproject(x: number, y: number, zoom: number): { lon: number; lat: number };
export interface ViewTile {
  x: number;
  y: number;
  left: number;
  top: number;
}
export function tilesForView(centerLon: number, centerLat: number, zoom: number, width: number, height: number): ViewTile[];
export function bboxForView(
  centerLon: number,
  centerLat: number,
  zoom: number,
  width: number,
  height: number,
): [number, number, number, number];
