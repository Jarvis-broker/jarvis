/**
 * 4 L-shaped corner brackets — typical HUD frame ornament.
 * Drop inside a position:relative parent.
 */
export function PanelCorners({ size = 14 }: { size?: number }) {
  const s = `${size}px`;
  return (
    <>
      <div className="corner tl" style={{ width: s, height: s }} />
      <div className="corner tr" style={{ width: s, height: s }} />
      <div className="corner bl" style={{ width: s, height: s }} />
      <div className="corner br" style={{ width: s, height: s }} />
    </>
  );
}
