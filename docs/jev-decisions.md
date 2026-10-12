# Jev quyết định child launch

Fork: `naicoi92/pi-subagents`; upstream nền: `nicobailon/pi-subagents` commit `8fcc3c78`.
Nguồn yêu cầu: operator trong session ngày triển khai — fork trực tiếp, Jev chọn agent/model, effort, persona; Jev lỗi thì dừng hỏi operator. Persona là role từ Agency Agents đã bàn trước.

## Contract

- AC-1: Trước mỗi child launch mới, Jev chọn agent trong catalog được phép; lựa chọn từ main chỉ là hint, không phải override.
- AC-2: Jev chọn một tuple `(agent, persona, model, effort)` bằng một câu hỏi Choice; không chọn model và effort độc lập. Tuple nằm trong catalog do operator cấu hình và registry có credentials, thỏa model scope.
- AC-3: Trước Choice, guardrail loại tuple có effort không được model hỗ trợ hoặc vượt `maxThinking` của agent. Không dùng fixed price hay classifier confidence làm quality score; cost phụ thuộc actual usage.
- AC-4: Jev chọn role Agency Agents; child nhận prompt chuyên môn tiếng Việt tương ứng, không thay tools/quyền của agent.
- AC-5: Jev unavailable, timeout, abort, lỗi hoặc response không hợp lệ → không launch; hỏi operator nếu có UI, headless trả lỗi yêu cầu operator. Không chat fallback, không tự retry.
- AC-6: Session ghi decision đã validate, backend, task digest và duration; không ghi raw task/provider error vào audit.
- AC-7: Scripted workflow child đi cùng decision boundary; resume giữ launch contract đã lưu, không đổi identity child giữa chừng.

## Test matrix

| AC | Test | Expected-value source |
|---|---|---|
| AC-1 | `AC-1 agent-selection` | Stub Jev chọn worker khác hint |
| AC-2 | `AC-2 joint-tuple`, `AC-2 model-scope` | Tuple literal từ catalog operator; registry fixture và allow scope |
| AC-3 | `AC-3 effort-ceiling` | Model reasoning=false / agent maxThinking |
| AC-4 | `AC-4 persona-launch` | Role prompt literal trong catalog |
| AC-5 | `AC-5 failure`, `AC-5 timeout`, `AC-5 invalid-choice`, `AC-5 operator` | Không có recorded child call; không retry |
| AC-6 | `AC-6 audit` | Decision validated + SHA-256 digest, không raw task |
| AC-7 | `AC-7 workflow-child` | Child từ `runs.run` đi qua executor |

## Role catalog

Agency Agents snapshot `f99f6aa910a442b0197b768ce0ea7751e35e2060`.
Catalog gồm role chuyên môn đã chọn trong `pi-so-subagents/docs/research/agency-role-catalog.md`.
Prompt là bản adaptation tiếng Việt do fork viết từ mô tả chuyên môn; không tuyên bố import nguyên văn full persona upstream. Giữ link provenance từng role. Không runtime-fetch.

## Runtime và privacy

Classifier dùng public `ctx.modelRegistry.getAvailableOfType()` / `classify()` như pi-auto. Host không có API → fail closed. Không tự đọc API key, không tự gọi TypeSafe HTTP.
Task và mô tả catalog gửi tới Jev provider đã cấu hình. Không gửi transcript/tool result hoặc credential. Operator phải dùng provider tin cậy với task nhạy cảm.
`pi-auto` tiếp tục chọn effort cho parent; fork chọn effort cho child qua launch contract. Không thay thinking của parent.
Native Pi children là phạm vi initial cutover; external-cli/external-job không có model/effort contract tương đương và không được chọn tự động.

## Candidate catalog

`jev.candidates` là allowlist tuple đầy đủ do operator khai báo: `{ id, agent, persona, model, effort }`. `model` dùng exact `provider/id`; `persona` dùng ID từ Agency role catalog. Không tách Choice cho model/effort, không tạo Cartesian product, không tự prune theo score. Không có candidate hợp lệ hoặc hơn 255 candidate → dừng hỏi operator. Chưa có dữ liệu eval thì không gắn quality score hoặc giá request cố định vào tuple.
