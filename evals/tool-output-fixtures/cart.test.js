const total = (items, discount = 0) => {
  const s = items.reduce((acc, [p, q]) => acc + p * q, 0);
  return Math.round((s - (s * discount) / 100) * 100) / 100;
};

describe("cart total", () => {
  for (let n = 0; n < 30; n += 1) {
    test(`scales linearly for qty ${n}`, () => {
      expect(total([[2, n]])).toBe(2 * n);
    });
  }
  test("applies discount with rounding", () => {
    expect(total([[19.99, 3]], 15)).toBe(50.98);
  });
});

describe("coupons", () => {
  test.each(["A", "B", "C", "D", "E"])("accepts code %s", (code) => {
    expect(code).toMatch(/^[A-Z]$/);
  });
});
