const SETUP = `
globalThis.__gplensCompare = async (shotDataUrl, cropDataUrl, rect) => {
  const load = (url) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = url;
  });

  const read = (source, sx, sy, sw, sh) => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, sw);
    canvas.height = Math.max(1, sh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return ctx.getImageData(0, 0, Math.max(1, sw), Math.max(1, sh)).data;
  };

  const shot = await load(shotDataUrl);
  const crop = await load(cropDataUrl);

  const px = Math.round(rect.x);
  const py = Math.round(rect.y);
  const pw = Math.round(rect.w);
  const ph = Math.round(rect.h);

  const mismatchAt = (dx, dy) => {
    const expected = read(shot, px + dx, py + dy, pw, ph);
    const actual = read(crop, 0, 0, Math.min(pw, crop.naturalWidth), Math.min(ph, crop.naturalHeight));
    let diffPixels = 0;
    let maxDelta = 0;
    let sample = null;
    const len = Math.min(expected.length, actual.length);
    for (let i = 0; i < len; i += 4) {
      const delta = Math.max(
        Math.abs(expected[i] - actual[i]),
        Math.abs(expected[i + 1] - actual[i + 1]),
        Math.abs(expected[i + 2] - actual[i + 2]),
      );
      if (delta > 0) {
        diffPixels += 1;
        if (!sample) {
          sample = {
            pixel: i / 4,
            shot: [expected[i], expected[i + 1], expected[i + 2]],
            crop: [actual[i], actual[i + 1], actual[i + 2]],
          };
        }
      }
      if (delta > maxDelta) maxDelta = delta;
    }
    return { offset: { dx, dy }, diffPixels, maxDelta, sample };
  };

  const atZero = mismatchAt(0, 0);
  const neighbours = [
    mismatchAt(1, 0),
    mismatchAt(-1, 0),
    mismatchAt(0, 1),
    mismatchAt(0, -1),
  ];
  const worstNeighbour = Math.min(...neighbours.map((item) => item.diffPixels));

  return {
    geometryOk: crop.naturalWidth === pw && crop.naturalHeight === ph,
    crop: { w: crop.naturalWidth, h: crop.naturalHeight },
    expected: { w: pw, h: ph },
    shot: { w: shot.naturalWidth, h: shot.naturalHeight },
    totalPixels: Math.round(Math.min(pw * ph, crop.naturalWidth * crop.naturalHeight)),
    diffPixels: atZero.diffPixels,
    maxDelta: atZero.maxDelta,
    sample: atZero.sample,
    mismatchPct: Number(((atZero.diffPixels / (pw * ph)) * 100).toFixed(4)),
    neighbourDiffPixels: neighbours.map((item) => item.diffPixels),
    aligned:
      atZero.diffPixels < worstNeighbour / 4 &&
      worstNeighbour > pw * ph * 0.05,
  };
};
`;

export function comparePixels(client, { shot, crop, rect }) {
  return client.evaluate(
    `${SETUP};__gplensCompare(${JSON.stringify(shot)}, ${JSON.stringify(crop)}, ${JSON.stringify(rect)})`,
  );
}
