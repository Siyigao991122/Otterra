"""
Wall extraction via parallel line detection.
1. Canny edges
2. Hough lines
3. Find parallel line pairs (wall = two close parallel lines)
4. Fill between pairs

Usage: python3 scripts/extract_walls_parallel.py <pdf-path>
"""
import sys, os
import cv2
import numpy as np
from pdf2image import convert_from_path


def extract_walls_parallel(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Step 1: Canny edge detection
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)

    # Step 2: Hough Line Transform (probabilistic for line segments)
    lines = cv2.HoughLinesP(edges, rho=1, theta=np.pi/180, threshold=50,
                            minLineLength=30, maxLineGap=10)

    if lines is None:
        print("  No lines detected!")
        return np.zeros((h, w), np.uint8), edges

    lines = lines.reshape(-1, 4)
    print(f"  Hough lines detected: {len(lines)}")

    # Classify lines as horizontal or vertical (within 10° tolerance)
    h_lines = []  # (x1, y1, x2, y2)
    v_lines = []

    for x1, y1, x2, y2 in lines:
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        length = np.hypot(dx, dy)
        if length < 20:
            continue
        angle = np.degrees(np.arctan2(dy, dx))
        if angle < 10:  # near horizontal
            h_lines.append((x1, y1, x2, y2))
        elif angle > 80:  # near vertical
            v_lines.append((x1, y1, x2, y2))

    print(f"  Horizontal lines: {len(h_lines)}, Vertical lines: {len(v_lines)}")

    # Step 3: Find parallel line pairs
    # For horizontal lines: group by y-coordinate, find pairs with small y-gap
    # For vertical lines: group by x-coordinate, find pairs with small x-gap
    wall_mask = np.zeros((h, w), dtype=np.uint8)

    # --- Horizontal parallel pairs ---
    # Sort by average y
    h_sorted = sorted(h_lines, key=lambda l: (l[1] + l[3]) / 2)

    MIN_WALL_THICK = 3
    MAX_WALL_THICK = 25

    h_paired = set()
    for i in range(len(h_sorted)):
        if i in h_paired:
            continue
        y_i = (h_sorted[i][1] + h_sorted[i][3]) / 2
        x_min_i = min(h_sorted[i][0], h_sorted[i][2])
        x_max_i = max(h_sorted[i][0], h_sorted[i][2])

        for j in range(i + 1, len(h_sorted)):
            if j in h_paired:
                continue
            y_j = (h_sorted[j][1] + h_sorted[j][3]) / 2
            gap = abs(y_j - y_i)

            if gap > MAX_WALL_THICK:
                break  # sorted by y, no more close lines
            if gap < MIN_WALL_THICK:
                continue

            # Check horizontal overlap
            x_min_j = min(h_sorted[j][0], h_sorted[j][2])
            x_max_j = max(h_sorted[j][0], h_sorted[j][2])
            overlap = min(x_max_i, x_max_j) - max(x_min_i, x_min_j)

            if overlap > 20:  # significant overlap = parallel pair
                # Fill rectangle between the two lines
                top = int(min(y_i, y_j))
                bottom = int(max(y_i, y_j))
                left = int(max(x_min_i, x_min_j))
                right = int(min(x_max_i, x_max_j))
                if right > left and bottom > top:
                    cv2.rectangle(wall_mask, (left, top), (right, bottom), 255, cv2.FILLED)
                h_paired.add(i)
                h_paired.add(j)
                break

    # --- Vertical parallel pairs ---
    v_sorted = sorted(v_lines, key=lambda l: (l[0] + l[2]) / 2)

    v_paired = set()
    for i in range(len(v_sorted)):
        if i in v_paired:
            continue
        x_i = (v_sorted[i][0] + v_sorted[i][2]) / 2
        y_min_i = min(v_sorted[i][1], v_sorted[i][3])
        y_max_i = max(v_sorted[i][1], v_sorted[i][3])

        for j in range(i + 1, len(v_sorted)):
            if j in v_paired:
                continue
            x_j = (v_sorted[j][0] + v_sorted[j][2]) / 2
            gap = abs(x_j - x_i)

            if gap > MAX_WALL_THICK:
                break
            if gap < MIN_WALL_THICK:
                continue

            # Check vertical overlap
            y_min_j = min(v_sorted[j][1], v_sorted[j][3])
            y_max_j = max(v_sorted[j][1], v_sorted[j][3])
            overlap = min(y_max_i, y_max_j) - max(y_min_i, y_min_j)

            if overlap > 20:
                left = int(min(x_i, x_j))
                right = int(max(x_i, x_j))
                top = int(max(y_min_i, y_min_j))
                bottom = int(min(y_max_i, y_max_j))
                if right > left and bottom > top:
                    cv2.rectangle(wall_mask, (left, top), (right, bottom), 255, cv2.FILLED)
                v_paired.add(i)
                v_paired.add(j)
                break

    print(f"  Paired: {len(h_paired)//2} horizontal, {len(v_paired)//2} vertical")

    return wall_mask, edges


def main():
    pdf_path = sys.argv[1]
    print(f"Rasterizing {os.path.basename(pdf_path)}...")
    images = convert_from_path(pdf_path, dpi=200, first_page=1, last_page=1)
    img = cv2.cvtColor(np.array(images[0]), cv2.COLOR_RGB2BGR)
    h, w = img.shape[:2]
    print(f"  Image: {w}x{h}")

    print("Detecting parallel line pairs...")
    wall_mask, edges = extract_walls_parallel(img)

    base = os.path.splitext(pdf_path)[0]

    # Save edges
    cv2.imwrite(f"{base}_edges.png", edges)
    print(f"  Saved: {os.path.basename(base)}_edges.png")

    # Save walls only
    cv2.imwrite(f"{base}_parallel_walls.png", 255 - wall_mask)
    print(f"  Saved: {os.path.basename(base)}_parallel_walls.png")

    # Green overlay
    overlay = img.copy()
    green = np.zeros_like(img)
    green[:, :, 1] = 220
    m = wall_mask > 0
    overlay[m] = (overlay[m] * 0.3 + green[m] * 0.7).astype(np.uint8)
    cv2.imwrite(f"{base}_parallel_overlay.png", overlay)
    print(f"  Saved: {os.path.basename(base)}_parallel_overlay.png")

    print("Done!")


if __name__ == '__main__':
    main()
