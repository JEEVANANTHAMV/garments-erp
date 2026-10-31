import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colors, brand, statusColors } from './designTokens.js';

const luminance = (hex) => hex.slice(1).match(/../g)
  .map((pair) => parseInt(pair, 16) / 255)
  .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('navigation, controls and small status labels meet 4.5:1 text contrast', () => {
  for (const [foreground, background] of [[colors.text, colors.sidebar], [colors.secondary, colors.surface], [colors.surface, brand[600]], ...Object.values(statusColors).map((s) => [s.label || s.text, s.background])]) {
    assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  }
});
