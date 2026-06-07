"""
Floor plan wall extraction using OpenCV contour analysis.

Usage: python3 scripts/extract_walls_cv.py <path-to-pdf> [--page 1]
"""
import sys
import os
import cv2
import numpy as np
from pdf2image import convert_from_path


def extract_walls(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Adaptive threshold
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv2.THRESH_BINARY_INV, 15, 10)

    # Remove tiny noise
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))

    # Find contours
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    wall_mask = np.zeros((h, w), dtype=np.uint8)
    kept = 0

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 20:
            continue

        rx, ry, rw, rh = cv2.boundingRect(cnt)
        aspect = max(rw, rh) / max(min(rw, rh), 1)
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)

        # Wall criteria:
        # 1. Elongated shape (long & thin)
        # 2. Large rectangular block
        # 3. Big area with moderate aspect ratio
        is_elongated = aspect > 3 and peri > 30
        is_large_rect = area > 200 and len(approx) <= 8 and aspect > 2
        is_wall_block = area > 500 and aspect > 1.5

        if is_elongated or is_large_rect or is_wall_block:
            cv2.drawContours(wall_mask, [cnt], -1, 255, cv2.FILLED)
            kept += 1

    print(f"  Contours: {len(contours)} total, {kept} kept as walls")

    # Close small gaps
    wall_mask = cv2.morphologyEx(wall_mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    return wall_mask, binary


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/extract_walls_cv.py <pdf-path>")
        sys.exit(1)

    pdf_path = sys.argv[1]
    page = 1
    if '--page' in sys.argv:
        page = int(sys.argv[sys.argv.index('--page') + 1])

    print(f"Rasterizing {os.path.basename(pdf_path)} page {page} at 200 DPI...")
    images = convert_from_path(pdf_path, dpi=200, first_page=page, last_page=page)
    pil_img = images[0]
    img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    h, w = img.shape[:2]
    print(f"  Image: {w}x{h}")

    print("Extracting walls...")
    wall_mask, binary = extract_walls(img)

    base = os.path.splitext(pdf_path)[0]

    # Walls only (black on white)
    cv2.imwrite(f"{base}_cv_walls.png", 255 - wall_mask)
    print(f"  Saved: {os.path.basename(base)}_cv_walls.png")

    # Green overlay on original
    overlay = img.copy()
    green_layer = np.zeros_like(img)
    green_layer[:, :, 1] = 220
    mask_bool = wall_mask > 0
    overlay[mask_bool] = (overlay[mask_bool] * 0.3 + green_layer[mask_bool] * 0.7).astype(np.uint8)
    cv2.imwrite(f"{base}_cv_overlay.png", overlay)
    print(f"  Saved: {os.path.basename(base)}_cv_overlay.png")

    print("Done!")


if __name__ == '__main__':
    main()
