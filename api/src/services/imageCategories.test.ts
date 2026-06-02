import {
  canonicalizeAiCategory,
  categoriesMatchForAudit,
  isBedroomCategory,
} from '../../../shared/imageCategories';

describe('imageCategories', () => {
  it('treats room as bedroom for hero eligibility', () => {
    expect(isBedroomCategory('room')).toBe(true);
    expect(isBedroomCategory('bedroom')).toBe(true);
    expect(isBedroomCategory('kitchen')).toBe(false);
  });

  it('matches room and bedroom for audit comparison', () => {
    expect(categoriesMatchForAudit('room', 'bedroom')).toBe(true);
    expect(categoriesMatchForAudit('Bedroom', 'bedroom')).toBe(true);
    expect(categoriesMatchForAudit('kitchen', 'bedroom')).toBe(false);
  });

  it('canonicalizes legacy room to bedroom', () => {
    expect(canonicalizeAiCategory('room')).toBe('bedroom');
  });
});
