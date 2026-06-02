import { isExternallyVerifiable, isOperatorAsserted } from './claimPolicy';

describe('claimPolicy', () => {
  it('routes externally-verifiable fact types to fact-check', () => {
    expect(isExternallyVerifiable('distance')).toBe(true);
    expect(isExternallyVerifiable('offer')).toBe(true);
    expect(isExternallyVerifiable('policy_term')).toBe(true);
    expect(isExternallyVerifiable('faq')).toBe(true);
  });

  it('exempts operator-asserted and dynamic claims from external fact-check', () => {
    expect(isExternallyVerifiable('amenity')).toBe(false);
    expect(isExternallyVerifiable('rent')).toBe(false);
    expect(isExternallyVerifiable('deposit')).toBe(false);
    expect(isExternallyVerifiable('room_size')).toBe(false);
  });

  it('identifies operator-asserted facilities', () => {
    expect(isOperatorAsserted('amenity')).toBe(true);
    expect(isOperatorAsserted('distance')).toBe(false);
  });
});
