/** Building styles. Each house occupies one tile; `data` bits 0-7 hold the type index. */
export interface HouseType {
  name: string;
  population: number;
  /** Visual model key on the client. */
  model: 'cottage' | 'terrace' | 'shop' | 'townhouse' | 'flats' | 'office' | 'church';
  /** Earliest year this style is built in era mode. */
  from: number;
  /** Preferred distance band from the town centre (0 = core, 2 = outskirts). */
  band: 0 | 1 | 2;
}

export const HOUSE_TYPES: readonly HouseType[] = [
  { name: 'Cottage', population: 6, model: 'cottage', from: 0, band: 2 },
  { name: 'Cottage', population: 8, model: 'cottage', from: 0, band: 2 },
  { name: 'Terraced houses', population: 22, model: 'terrace', from: 0, band: 1 },
  { name: 'Shops', population: 14, model: 'shop', from: 0, band: 0 },
  { name: 'Town house', population: 30, model: 'townhouse', from: 0, band: 0 },
  { name: 'Church', population: 4, model: 'church', from: 0, band: 1 },
  { name: 'Flats', population: 70, model: 'flats', from: 1925, band: 0 },
  { name: 'Office block', population: 95, model: 'office', from: 1950, band: 0 },
];

export const houseType = (data: number): HouseType => HOUSE_TYPES[data & 0xff] ?? HOUSE_TYPES[0]!;
