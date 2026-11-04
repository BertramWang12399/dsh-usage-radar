<p align="center">
  <img src="icon.svg" width="72" alt="Usage Radar">
</p>

# 用量雷达 · Usage Radar

DSH（DeepSeek Harness）Web 界面插件：实时监测 token 与额度用量，用最直观的图形呈现。
Real-time token & quota radar for the DeepSeek Harness Web UI.

<p align="center"><b>环形仪表盘 · 输出曲线 · 额度倒计时 · 缓存命中率</b></p>

## 安装 Installation

本包零依赖、无安装脚本。两种方式：

1. **本地目录安装**（推荐，永久生效于当前 profile）：

   克隆本仓库到任意目录，然后在 DSH 里让插件管理器安装该目录（Host 会把它以
   `link:` 形式接入 profile 并立即热载）：

   ```powershell
   git clone https://github.com/BertramWang12399/dsh-usage-radar.git
   ```

   在 DSH 插件管理页选择安装 `dsh-usage-radar` 所在目录即可；
   命令行用户也可以直接调用插件管理器的 `install_bundle`，目标填该目录。


## 它长什么样

1. **会话标题栏常驻环形仪表盘**（`conversation.session.header.utilities`）
   一枚 18px 的环形进度图 + 上下文占用百分比，颜色随压力分级（蓝 → 琥珀 → 红）；
   模型生成中时圆环发光、右侧出现呼吸绿点。

2. **点击展开「雷达面板」**（`shell.overlay` 浮层，全窗口最高层）
   - 116px 大号环形表：中心大号百分比 + 上下文占用绝对值 / 窗口上限；
   - 右侧四条微型条形图：输入 / 输出 / 缓存读取 / 推理 token；
   - 折线面积图：最近 48 步输出 token 曲线（平滑贝塞尔 + 渐变填充 + 末点高亮）；
   - 今日额度进度条（带刻度、剩余量与次日 00:00 重置倒计时）；
   - 明细 chip：轮数、步数、缓存命中率、当前模型。

   实时性：生成中 450ms、空闲 1300ms 自适应轮询；数字与圆环均带缓动动画。
   关闭方式：× / Esc / 点击面板外任意位置。

## 数据来源（Host 半边）

| 数值 | 来源 |
|---|---|
| 上下文占用 | `tokenMeter.measure(session).totalTokens`（2.5s 缓存，失败回退到最近一次 usage） |
| 上下文窗口 | `session.requestContext().contextWindow` |
| 输入 / 输出 / 缓存 / 推理 | `session/event` 中 `assistant/message.usage` 的累计与逐步采样 |
| 流式实时用量 | `agent/assistant-stream` 的 `usage` chunk |
| 生成状态 | `agent/status`（`running` / `idle`） |
| 今日额度 | 当前进程内活跃会话当日 usage 累计（首次读取时回放会话日志播种） |

计费口径：额度只累计**输入 + 输出**，不含缓存读取（`cacheReadTokens`）。缓存命中通常远大于新增 token，
若把缓存读算进额度，任何长会话都会瞬间打满额度条。缓存读取单独在面板里以「缓存读取」一项展示，并给出命中率。

所有 token 数据都来自会话日志与运行时事件，插件不自己编造估算；读不到的字段原样留空。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里覆盖该行 config 即可，无需重新安装：

```yaml
- id: dsh-usage-radar
  name: dsh-usage-radar
  config:
    dailyBudget: 2000000   # 今日额度（input+output 计），默认 200 万
    sampleLimit: 48        # 曲线保留的步数，8–240
    measureTtlMs: 2500     # 上下文重新计价的缓存窗口
```

## 接口

- `GET /dsh-usage-radar/api/health` — 存活探针（`served` 为已服务的快照请求数，客户端在轮询就会增长）
- `GET /dsh-usage-radar/api/snapshot?session=<sessionId>` — 面板绘制用的 JSON 快照

只读、无副作用、不做任何模型侧改动。

## 已知边界

- **今日额度是进程内统计**：只在当前 DSH 进程运行期间累计；重启后从当前活跃会话当日日志重新播种，未加载的历史会话不计入。
- 未在当前进程加载的会话只能显示已记录统计，不显示实时上下文。
- 无 `tokenMeter` 的装配下，上下文占用回退为最近一次请求的 input+output。

## 验证

- Host：`GET /dsh-usage-radar/api/snapshot?session=…` 返回真实会话数值；
- Client：标题栏出现环形仪表盘，面板数据与接口一致，浅色/深色主题均只使用 `--dsw-alias-*` 令牌。

## 缓存命中率（1.1.0 新增，纯观测）

- 面板新增「缓存命中率（会话）」区块：最近 24 步小柱状图（未命中琥珀色）与最近几次未命中原因。
- 口径与 DSH 内置输入栏一致：`cacheRead / (cacheRead + input + cacheWrite)`。
- 未命中归因（只在命中率 < 60% 时分类，**不改写任何请求**）：
  `cold`（首次请求）· `model-switch`（切换模型/provider）· `new-input`（本步新增 ≥ 4000 token 输入）
  · `prefix-changed`（前缀变化后缓存重建）· `unknown`。
- 想真正提高命中率，减少 `model-switch` 与 `prefix-changed` 两类即可；
  本插件不自动干预请求内容，原因分类只是把问题暴露出来。

## 生态 Ecosystem

- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— DSH 插件清单，欢迎提交收录。
- 名字 `dsh-usage-radar` 与 npm 同名包（当前空闲）保持一致，欢迎取用、二次分发。

变更记录见 [CHANGELOG.md](CHANGELOG.md)，许可证 [MIT](LICENSE)。
