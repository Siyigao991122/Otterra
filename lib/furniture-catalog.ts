import type { Furniture } from "./types"

type CatalogFurniture = Omit<Furniture, "id" | "position" | "rotation">

export const FURNITURE_CATALOG: Record<string, CatalogFurniture[]> = {
  seating: [
    {
      type: "sofa",
      name: "Modern Sofa",
      color: "#4a5568",
      dimensions: { width: 2.2, height: 0.85, depth: 0.9 },
    },
    {
      type: "sofa",
      name: "Sectional Sofa",
      color: "#2d3748",
      dimensions: { width: 3, height: 0.85, depth: 1.5 },
    },
    {
      type: "chair",
      name: "Accent Chair",
      color: "#d4a853",
      dimensions: { width: 0.7, height: 0.85, depth: 0.7 },
    },
    {
      type: "chair",
      name: "Lounge Chair",
      color: "#718096",
      dimensions: { width: 0.8, height: 0.9, depth: 0.85 },
    },
  ],
  tables: [
    {
      type: "table",
      name: "Coffee Table",
      color: "#8b5a2b",
      dimensions: { width: 1.2, height: 0.45, depth: 0.6 },
    },
    {
      type: "table",
      name: "Dining Table",
      color: "#654321",
      dimensions: { width: 1.8, height: 0.75, depth: 0.9 },
    },
    {
      type: "table",
      name: "Side Table",
      color: "#2d3748",
      dimensions: { width: 0.5, height: 0.55, depth: 0.5 },
    },
    {
      type: "table",
      name: "Desk",
      color: "#4a5568",
      dimensions: { width: 1.4, height: 0.75, depth: 0.7 },
    },
  ],
  lighting: [
    {
      type: "lamp",
      name: "Floor Lamp",
      color: "#f5f5dc",
      dimensions: { width: 0.4, height: 1.6, depth: 0.4 },
    },
    {
      type: "lamp",
      name: "Table Lamp",
      color: "#e8e8e8",
      dimensions: { width: 0.3, height: 0.5, depth: 0.3 },
    },
    {
      type: "lamp",
      name: "Arc Lamp",
      color: "#f0f0f0",
      dimensions: { width: 0.5, height: 1.8, depth: 0.5 },
    },
  ],
  bedroom: [
    {
      type: "bed",
      name: "Queen Bed",
      color: "#8b7355",
      dimensions: { width: 1.6, height: 1, depth: 2.1 },
    },
    {
      type: "bed",
      name: "King Bed",
      color: "#6b5344",
      dimensions: { width: 1.9, height: 1, depth: 2.1 },
    },
    {
      type: "table",
      name: "Nightstand",
      color: "#5a4a3a",
      dimensions: { width: 0.5, height: 0.55, depth: 0.4 },
    },
  ],
  decor: [
    {
      type: "plant",
      name: "Indoor Plant",
      color: "#2d5a27",
      dimensions: { width: 0.4, height: 0.8, depth: 0.4 },
    },
    {
      type: "plant",
      name: "Large Plant",
      color: "#3d7a37",
      dimensions: { width: 0.6, height: 1.2, depth: 0.6 },
    },
    {
      type: "rug",
      name: "Area Rug",
      color: "#8b7355",
      dimensions: { width: 2.5, height: 0.02, depth: 1.8 },
    },
    {
      type: "rug",
      name: "Round Rug",
      color: "#a08060",
      dimensions: { width: 2, height: 0.02, depth: 2 },
    },
  ],
  storage: [
    {
      type: "bookshelf",
      name: "Bookshelf",
      color: "#4a3728",
      dimensions: { width: 0.9, height: 1.8, depth: 0.35 },
    },
    {
      type: "bookshelf",
      name: "TV Stand",
      color: "#2d3748",
      dimensions: { width: 1.6, height: 0.5, depth: 0.4 },
    },
    {
      type: "bookshelf",
      name: "Console Table",
      color: "#5a4a3a",
      dimensions: { width: 1.2, height: 0.8, depth: 0.35 },
    },
  ],
  electronics: [
    {
      type: "tv",
      name: "Smart TV",
      color: "#1a1a1a",
      dimensions: { width: 1.4, height: 0.8, depth: 0.1 },
    },
    {
      type: "tv",
      name: "Large TV",
      color: "#0a0a0a",
      dimensions: { width: 1.8, height: 1, depth: 0.1 },
    },
  ],
}
