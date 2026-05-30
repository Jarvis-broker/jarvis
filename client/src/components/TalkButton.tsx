import { useStore } from "../lib/store";

interface Props {
  onTalk: () => void;
}

export function TalkButton({ onTalk }: Props) {
  const state = useStore((s) => s.state);
  const isConnected = useStore((s) => s.isConnected);
  const disabled = !isConnected || state !== "idle";

  return (
    <button className="talk-btn" onClick={onTalk} disabled={disabled}>
      🎤  Talk  <span className="hint">(SPACE)</span>
    </button>
  );
}
