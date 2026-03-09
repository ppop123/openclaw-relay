# 架构审计评审 / Architecture Audit Review

[中文](#中文) | [English](#english)

---

## 中文

日期：2026-03-07
范围：`README.md`、`docs/*`、`protocol/*`、`relays.json`
评审视角：资深系统架构师 / 实施就绪审计

### 总体评价

OpenClaw Relay 的整体方向是**正确的**：仅出站连接、Relay 极简化、协议分层、自托管友好——这些都契合 NAT 穿透远程访问的实际约束。

经过五轮评审，我的总体判断：

- **战略方向**：强
- **协议分解**：强
- **安全设计成熟度**：中等，有几个关键细节在实施前必须修正
- **可运维性和生产就绪度**：中低
- **文档一致性**：修订前中低，修订后有实质改善

直白地说：这是一份好的架构草案，但在安全握手、配对模型、重试语义和文档边界收紧之前，**还不能当作实施合同使用**。

### 第一轮：方案架构评审

#### 做对的地方

- 选择**哑中继（dumb relay）**在架构上是合理的。信任最小化、运维成本低、实现复杂度低。
- **Layer 0 / 1 / 2 / 3** 的分层划分恰当且清晰。为多客户端和多 SDK 留出了空间，同时不会过度耦合 Relay。
- 聚焦**仅出站连接**，完全符合家庭实验室、小型企业和个人开发者环境的需求。
- 系统把**网关作为产品大脑**、Relay 作为传输原语，这个边界划分是健康的。

#### 薄弱之处

- 仓库的写法一半像设计草案、一半像发布产品。
- `README.md`、`docs/quick-start.md` 和 `docs/self-host-relay.md` 读起来像可以立即运行，但仓库当前只包含文档。
- 组件表链接的路径实际上还不存在。

#### 架构结论

方案架构可行，但文档需要明确声明：**这是一个规范仓库，尚非实现仓库**。

### 第二轮：安全与协议评审

#### 发现的关键问题

1. **重连时会话密钥（Session Key）复用风险**
   - 原始 Layer 1 密钥派生仅使用长期密钥。
   - 客户端断连后重连，可能派生出相同的会话密钥，nonce 计数器也会重置。
   - 对 AES-GCM 来说，这是不可接受的。

2. **配对模型（Pairing Model）不完整**
   - 文档描述了在配置中审批客户端公钥。
   - 但没有解释新客户端密钥何时以及如何变为可信。

3. **广播语义与端到端加密设计不兼容**
   - Layer 0 允许 `to: "*"` 广播。
   - 但 Layer 1 为每个客户端生成独立的会话密钥。
   - 一份密文无法安全地广播给多个客户端。

4. **令牌熵值（Token Entropy）表述不一致**
   - 草案描述了 128 位令牌，同时又展示了 12 字符的友好码。
   - 两者并不等价。

5. **前向保密（Forward Secrecy）被夸大**
   - 原始措辞暗示了部分前向保密。
   - 以文档中描述的静态身份密钥流程，v1 不提供真正的前向保密。

#### 已修正

- 在 Layer 1 密钥派生中增加了**每连接会话随机数（per-connection session nonce）**。
- 记录了**显式配对模式**：网关仅在用户主动发起配对窗口期间接受新客户端密钥。
- 要求客户端**锁定并验证网关身份（pin and verify）**。
- 从 Layer 0 移除了 v1 应用层广播语义。
- 修正了令牌声明，要求**至少 96 位熵值**，文档中仍可使用短示例以提高可读性。
- 修正了安全属性表，明确标注 **v1 无前向保密**。

#### 安全结论

修订后协议的一致性大幅提升。在正式实施前，仍强烈建议为 v2 是否采用 **Noise 风格临时握手（Noise-style ephemeral handshake）** 编写 ADR。

### 第三轮：可靠性与运维评审

#### 做得好的地方

- Relay 状态刻意设计为仅内存存储。
- `/status` 健康检查端点是正确的最小运维接口。
- 限速和载荷上限已纳入设计。

#### 缺失之处

- 文档未明确说明 v1 是否为**单节点**。
- 公共 Relay 发现依赖单一注册表位置，这是可以避免的可用性弱点。
- 可观测性（Observability）仅非正式提及，未提升为架构要求。
- 防滥用机制存在，但未被作为 MVP 一等公民对待。

#### 已修正

- 明确声明 **v1 目标为单 Relay 节点**。
- 在技术设计中增加了**非功能性目标**。
- 增加了**注册表缓存 + 镜像回退**指引。
- 将结构化日志和防滥用控制纳入 **Phase 1 MVP** 预期。

#### 运维结论

架构适合轻量级 Relay 产品，但应对运维边界保持诚实：**简单、单节点、可重启恢复，v1 不做高可用**。

### 第四轮：演进与交付路线评审

#### 主要发现

从风险角度来看，实施阶段排序不当。

具体来说，原始草案将"Layer 1 完整实现"放在 Phase 2，但端到端安全才是整个系统的核心价值主张。

#### 已修正

- 将**安全配对和 Layer 1 会话建立**提前到 Phase 1。
- 通知、历史记录、JS SDK 和局域网发现保留在后续阶段。
- 将 MVP 重新定义为**先做安全的远程聊天**，再做丰富生态功能。

#### 交付结论

正确的顺序是：

1. 安全与配对
2. 最小可用远程聊天
3. 可观测性与防滥用控制
4. 丰富客户端能力
5. 生态扩展

任何其他顺序都是在信任边界建立之前优化演示效果。

### 第五轮：文档一致性评审

#### 主要问题

- 草案语言和产品语言混杂。
- 部分示例看起来像权威运维指南，实际只是愿景描述。
- 少数协议声明在不同文档间互相矛盾。

#### 已修正

- 在面向用户的文档中添加了明确的**草案 / 计划实现**免责声明。
- 修正了 README 组件表，不再将尚未存在的路径标注为已存在。
- 收紧了协议中关于重连、重试和配对行为的措辞。
- 在 Layer 2 中增加了重试语义（Retry Semantics），确保未来的客户端实现不会假设恰好一次（exactly-once）送达。

#### 文档结论

修订后的文档更接近**工程设计包**，而非半成品的产品宣传册。

### 优先级建议

#### P0：编码开始前必须达成

- 冻结修正后的**配对和会话密钥模型**。
- 为**网关身份锁定和客户端审批流程**编写 ADR。
- Relay 对加密载荷保持**非广播**。
- 在代码真正落地之前，将本仓库视为**规范仓库**。

#### P1：MVP 实施期间完成

- 添加结构化指标：活跃频道数、活跃客户端数、拒绝的 join 请求、被限速的帧、超大载荷、重连次数。
- 添加本地**最近已知可用 Relay 注册表缓存（last-known-good relay registry cache）**。
- 为公共 Relay 运营者编写小型**运维手册**。
- 添加合约测试，验证 Go、JS、Python SDK 在 Layer 0–2 上的互操作性。

#### P2：公共生态扩展前规划

- 考虑采用 **Noise IK/XX** 或等效的临时握手协议以实现前向保密。
- 仅在真实负载需要时才定义集群或分片 Relay 行为。
- 添加签名注册表清单和镜像策略。
- 添加协议演进的兼容性 / 版本策略。

### 架构评分

以三十年经验系统架构师的视角，我的评分如下：

- **概念架构**：8/10
- **修正后的安全模型**：7/10
- **文档中的运维成熟度**：6/10
- **修订后的文档诚实度 / 一致性**：8/10
- **当前实施就绪度**：6.5/10

这意味着项目现在可以进入实施阶段，**前提是团队将更新后的协议和配对规则视为硬性约束，而非可选优化**。

### 建议的后续文档

- `docs/adr-001-single-node-relay.md`
- `docs/adr-002-pairing-and-client-approval.md`
- `docs/adr-003-relay-registry-resilience.md`
- `docs/operator-runbook.md`
- `docs/compatibility-policy.md`

---

## English

Date: 2026-03-07
Scope: `README.md`, `docs/*`, `protocol/*`, `relays.json`
Reviewer stance: senior systems architect / implementation-readiness audit

### Executive Summary

OpenClaw Relay's overall direction is **correct**: outbound-only connectivity, relay minimalism, protocol layering, and self-hosting friendliness all match the real constraints of NAT-traversed remote access.

My overall judgment after five review rounds is:

- **Strategic direction**: strong
- **Protocol decomposition**: strong
- **Security design maturity**: medium, with several critical details that needed correction before implementation
- **Operability and production readiness**: medium-low
- **Documentation consistency**: medium-low before revision, now materially improved

In plain terms: this is a good architecture draft, but it was **not yet ready to be treated as an implementation contract** until the security handshake, pairing model, retry semantics, and document boundary were tightened.

### Round 1: Solution Architecture Review

#### What is right

- The choice of a **dumb relay** is architecturally sound. It minimizes trust, operational cost, and implementation complexity.
- The split into **Layer 0 / 1 / 2 / 3** is appropriate and clean. It gives room for multiple clients and SDKs without over-coupling the relay.
- The focus on **outbound-only connections** is exactly right for home-lab, SMB, and personal developer environments.
- The system keeps the **gateway as the product brain** and the relay as a transport primitive. That boundary is healthy.

#### What was weak

- The repository was written partly like a design draft and partly like a shipping product.
- `README.md`, `docs/quick-start.md`, and `docs/self-host-relay.md` read as immediately runnable, while the repo currently contains only documents.
- The component table linked to paths that do not exist yet.

#### Architectural conclusion

The solution architecture is viable, but documentation needed to clearly declare: **this repository is a draft/spec repository, not yet an implementation repository**.

### Round 2: Security and Protocol Review

#### Critical issues found

1. **Session key reuse risk on reconnect**
   - The original Layer 1 derivation used long-lived keys only.
   - If a client disconnected and reconnected, the same session key could be derived again and nonce counters could restart.
   - With AES-GCM, that is unacceptable.

2. **Pairing model was incomplete**
   - The docs described approved client public keys in configuration.
   - But the actual pairing flow did not explain when a new client key becomes trusted.

3. **Broadcast semantics were incompatible with E2E design**
   - Layer 0 allowed `to: "*"` broadcast.
   - But Layer 1 gives each client a distinct session key.
   - One ciphertext cannot safely be broadcast to multiple clients.

4. **Token entropy statement was inconsistent**
   - The draft described a 128-bit token while showing a 12-character friendly code.
   - Those are not equivalent.

5. **Forward secrecy was overstated**
   - The original wording implied partial forward secrecy.
   - With static identity keys in the documented flow, v1 does not provide true forward secrecy.

#### Corrections applied

- Added **per-connection session nonces** to Layer 1 key derivation.
- Documented **explicit pairing mode**: the gateway accepts a new client key only during a user-initiated pairing window.
- Required the client to **pin and verify gateway identity**.
- Removed v1 application-layer broadcast semantics from Layer 0.
- Corrected the token statement to require **at least 96 bits of entropy**, while allowing short examples in docs for readability.
- Corrected the security property table to say **no forward secrecy in v1**.

#### Security conclusion

After revision, the protocol is much more coherent. Before implementation, I would still strongly recommend an ADR for whether v2 adopts a **Noise-style ephemeral handshake**.

### Round 3: Reliability and Operations Review

#### What is good

- Relay state is intentionally in-memory only.
- `/status` health endpoint is the right minimal operational surface.
- Rate limiting and payload caps are already part of the design.

#### What was missing

- The docs did not clearly say whether v1 is **single-node only**.
- Public relay discovery depended on one registry location, which is an avoidable availability weakness.
- Observability was described informally, but not elevated to architectural requirements.
- Abuse management was present, but not called out as a first-class MVP concern.

#### Corrections applied

- Declared that **v1 targets a single relay node**.
- Added **non-functional targets** to the technical design.
- Added **registry cache + mirror fallback** guidance.
- Moved structured logging and abuse controls into **Phase 1 MVP** expectations.

#### Operations conclusion

The architecture is appropriate for a lightweight relay product, but it should stay honest about its operational boundary: **simple, single-node, restart-tolerant, not HA in v1**.

### Round 4: Evolution and Delivery Roadmap Review

#### Main finding

The implementation phases were ordered incorrectly from a risk perspective.

Specifically, the original draft placed "Layer 1 fully implemented" in Phase 2, even though E2E security is the core value proposition of the entire system.

#### Corrections applied

- Moved **secure pairing and Layer 1 session establishment** into Phase 1.
- Kept notifications, history, JS SDK, and LAN discovery in later phases.
- Reframed MVP as **secure remote chat first**, then richer ecosystem features.

#### Delivery conclusion

This is the correct order:

1. Security and pairing
2. Minimal usable remote chat
3. Observability and abuse controls
4. Rich client capabilities
5. Ecosystem expansion

Anything else would optimize demo value before securing the trust boundary.

### Round 5: Documentation Consistency Review

#### Main issues

- Draft and product language were mixed together.
- Some examples looked operationally authoritative when they were only aspirational.
- A few protocol statements contradicted each other across documents.

#### Corrections applied

- Added explicit **draft / planned implementation** disclaimers to user-facing documents.
- Fixed the README component table so it no longer points to missing paths as if they already exist.
- Tightened protocol wording around reconnect, retry, and pairing behavior.
- Added retry semantics in Layer 2 so future client implementations do not assume exactly-once behavior.

#### Documentation conclusion

The docs are now closer to an **engineering design package** and less like a half-implemented product brochure.

### Priority Recommendations

#### P0: Must be true before coding starts

- Freeze the corrected **pairing and session-key model**.
- Write an ADR for **gateway identity pinning and client approval flow**.
- Keep the relay **non-broadcast for encrypted payloads**.
- Treat this repo as a **spec repository** until code actually lands.

#### P1: Should be done during MVP implementation

- Add structured metrics: active channels, active clients, rejected joins, rate-limited frames, oversized payloads, reconnect counts.
- Add a local **last-known-good relay registry cache**.
- Define a small **operational runbook** for public relay operators.
- Add contract tests that validate Layer 0-2 interoperability across Go, JS, and Python SDKs.

#### P2: Should be planned before public ecosystem growth

- Consider **Noise IK/XX** or an equivalent ephemeral handshake for forward secrecy.
- Define cluster or sharded relay behavior only when real load requires it.
- Add signed registry manifests and mirror policy.
- Add compatibility/versioning policy for protocol evolution.

### Architectural Verdict

If I assess this as a 30-year systems architect, my verdict is:

- **Conceptual architecture**: 8/10
- **Security model after correction**: 7/10
- **Operational maturity in docs**: 6/10
- **Documentation honesty/consistency after revision**: 8/10
- **Implementation readiness right now**: 6.5/10

This means the project is now in a good place to move into implementation, **provided the team treats the updated protocol and pairing rules as hard constraints rather than optional refinements**.

### Recommended Next Documents

- `docs/adr-001-single-node-relay.md`
- `docs/adr-002-pairing-and-client-approval.md`
- `docs/adr-003-relay-registry-resilience.md`
- `docs/operator-runbook.md`
- `docs/compatibility-policy.md`
