import { describe, it, expect } from 'vitest';
import { belongsToCity } from '../backend/src/services/regions.js';
describe('全国城市边界', () => {
  it('普通地级市允许其下辖区县', () => {
    expect(belongsToCity('330106', '330100')).toBe(true);
    expect(belongsToCity('330206', '330100')).toBe(false);
  });
  it('直辖市按整市行政范围查询', () => {
    expect(belongsToCity('310101', '310000')).toBe(true);
    expect(belongsToCity('320100', '310000')).toBe(false);
  });
  it('省直辖县级市不能误包含邻近城市', () => {
    expect(belongsToCity('469005', '469005')).toBe(true);
    expect(belongsToCity('469006', '469005')).toBe(false);
    expect(belongsToCity('429005', '429004')).toBe(false);
  });
});
