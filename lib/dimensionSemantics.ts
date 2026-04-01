/**
 * Dimension semantics and 3D axis mapping for Otterra.
 *
 * DB semantics (products table):
 * - width_m  = overall left-right width (when facing the product)
 * - length_m = overall front-back footprint depth/length
 * - height_m = overall max height (floor to top)
 *
 * 3D scene semantics (Three.js right-handed, Y-up):
 * - X axis = width  (left-right)
 * - Y axis = height (up)
 * - Z axis = depth  (front-back)
 *
 * DB → Furniture.dimensions mapping:
 * - width_m  → dimensions.width  → X extent
 * - length_m → dimensions.depth  → Z extent
 * - height_m → dimensions.height → Y extent
 *
 * BoxGeometry args: [width, height, depth] = [X, Y, Z]
 */

export const AXIS_SEMANTICS = {
  X: "width" as const,  // left-right
  Y: "height" as const, // up
  Z: "depth" as const,  // front-back
}
