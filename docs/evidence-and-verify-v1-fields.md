# Evidence & Verify v1：字段清单

全部字段、嵌套类型、联合分支与约束只写在一处：[`contracts/evidence.openapi.yaml`](../contracts/evidence.openapi.yaml)（OpenAPI 3.1，`components.schemas`，按声明顺序）。业务约束、可信字段来源及支持范围见 [设计与实施说明](evidence-and-verify-v1.md)。

读法：

- 不在 `required` 中的字段可省略；数组与对象不可用 `null` 替代。
- 记录类型以 `allOf` 继承 `EvidenceRecord`（`IssueContract` 另含 `ContractContentFields`），并以 `unevaluatedProperties: false` 拒绝未知字段。
- 联合类型（`MaterialSelector`、`CheckConfiguration`、`VerifierIdentity`）是 `oneOf` 加 `discriminator: kind`，每个分支是一个具名 schema。
- `DateTime` 为 UTC RFC3339（带 pattern，不用 `format: date-time`）；`Digest` 为 `sha256:` 加 64 位小写十六进制。
- `format: non-blank` 与 `minLength: 1` 一起表示去掉首尾空白后不能为空。

由它生成、不手改的文件（`pnpm generate:evidence`）：

| 文件                                                                                            | 生成器                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/protocol/src/evidence.gen.ts`                                                         | openapi-typescript                               |
| `apps/server/internal/store/evidence_models_generated.go`                                       | oapi-codegen（仅 models）                        |
| `packages/protocol/src/evidence-schema.json`、`apps/server/internal/store/evidence-schema.json` | JSON Schema 2020-12，Ajv 与 jsonschema/v6 校验用 |

`pnpm audit:evidence-contract`（`verify` 与 `scripts/check-changed.sh` 都会运行）检查生成文件是否最新，并用 oasdiff 对比 merge base 上的契约；有意的不兼容变更记入 `contracts/oasdiff-err-ignore.txt`。
