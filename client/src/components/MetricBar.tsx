interface Props {
  label: string;
  value: number; // 0-100
  text: string;
  color: string; // hex
}

export function MetricBar({ label, value, text, color }: Props) {
  let barColor = color;
  let textColor = color;
  if (value > 85) {
    barColor = "#ff3355";
    textColor = "#ff3355";
  } else if (value > 65) {
    barColor = "#ff6b00";
    textColor = "#ff6b00";
  }
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div className="metric-bar">
      <div className="metric-bar-header">
        <span className="metric-label">{label}</span>
        <span className="metric-value" style={{ color: textColor }}>
          {text}
        </span>
      </div>
      <div className="metric-bar-track">
        <div
          className="metric-bar-fill"
          style={{
            width: `${clamped}%`,
            background: barColor,
            boxShadow: `0 0 6px ${barColor}88`,
          }}
        />
      </div>
    </div>
  );
}
