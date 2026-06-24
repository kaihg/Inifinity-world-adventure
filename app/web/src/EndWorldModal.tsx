import { useState } from "react";

interface Props {
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

// 「封存世界」是操作行為（非遊戲資訊），由 header 操作列開啟此 modal 確認。
// 比照死亡抉擇 modal 的 end-world：按鈕二次確認即可，不需打字。
// （後端 /api/world/end 仍要求 confirmText === "封存"，由 onConfirm 程式帶入。）
export function EndWorldModal({ onClose, onConfirm }: Props) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    // onConfirm 內部自行 catch 不 rethrow（成功會把世界畫面 unmount）；
    // 用 finally 確保封存失敗時也把 modal 收回，不停在可立即再送的狀態
    try { await onConfirm(); }
    finally { setBusy(false); onClose(); }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header"><h2>結束並封存世界</h2></div>
        <section className="panel">
          <p>確定要結束並封存目前世界嗎？此動作會把整個世界封存到 archives/，並回到世界初始化畫面。</p>
          <div className="modal-actions">
            <button className="chip" disabled={busy} onClick={onClose}>取消</button>
            <button className="send-btn" disabled={busy} onClick={handleConfirm}>
              {busy ? "封存中…" : "確定封存"}
            </button>
          </div>
        </section>
      </aside>
    </div>
  );
}
