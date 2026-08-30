export interface AttachmentsPanelController { dispose(): void; }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

const allowedMediaTypes = new Set(["image/png", "image/jpeg", "application/pdf"]);

export function mountAttachmentsPanel(host: HTMLElement, options: {
  readonly ensureSessionId: () => Promise<string>;
  readonly getPlanId: () => string | null;
  readonly openAgentPrompt: (prompt: string) => void;
  readonly fetchImpl?: typeof fetch;
}): AttachmentsPanelController {
  const fetchImpl = options.fetchImpl ?? fetch;
  host.className = "agent-attachments-panel";
  host.dataset.attachmentsPanel = "true";
  const header = element("header");
  const copy = element("div"); copy.append(element("p", "照片、PDF 与量尺"), element("h4", "导入附件并提出观察"));
  header.append(copy);
  const form = element("form"); form.dataset.attachmentUpload = "true";
  const fileLabel = element("label", "选择 PNG、JPEG 或 PDF");
  const file = element("input"); file.type = "file"; file.accept = "image/png,image/jpeg,application/pdf"; file.required = true; fileLabel.append(file);
  const scopeLabel = element("label", "希望绑定到");
  const scope = element("select"); scope.name = "scope";
  for (const [value, label] of [["plan", "当前方案"], ["instance", "组件实例"], ["placement", "安装位置"], ["connection", "连接"], ["port", "端口"], ["mount", "安装位"], ["firmware", "BIOS / 固件"]] as const) {
    const option = element("option", label); option.value = value; scope.append(option);
  }
  scopeLabel.append(scope);
  const subjectLabel = element("label", "对象 ID（方案级可留空）");
  const subject = element("input"); subject.name = "subject"; subject.maxLength = 160; subjectLabel.append(subject);
  const measurementLabel = element("label", "可选量距/方向说明");
  const measurement = element("input"); measurement.name = "measurement"; measurement.maxLength = 240; measurement.placeholder = "例如：两点间 118 mm，方向由前向后"; measurementLabel.append(measurement);
  const privacy = element("p", "原件按私有附件处理；归档前会提示元数据与正文提取范围。解析结果只是待确认观察，不会直接改方案。"); privacy.dataset.attachmentPrivacy = "true";
  const submit = element("button", "上传到当前本地会话"); submit.type = "submit";
  const status = element("p"); status.setAttribute("role", "status"); status.dataset.attachmentStatus = "true";
  form.append(fileLabel, scopeLabel, subjectLabel, measurementLabel, privacy, submit, status);
  host.replaceChildren(header, form);

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    void (async () => {
      submit.disabled = true;
      try {
        const selected = file.files?.[0];
        if (!selected || !allowedMediaTypes.has(selected.type)) throw new Error("请选择 PNG、JPEG 或 PDF 文件");
        const planId = options.getPlanId();
        if (!planId) throw new Error("请先选择一个方案");
        const sessionId = await options.ensureSessionId();
        const response = await fetchImpl(`/api/agent/sessions/${encodeURIComponent(sessionId)}/uploads`, {
          method: "POST", headers: { "Content-Type": selected.type, Accept: "application/json" }, body: await selected.arrayBuffer(),
        });
        const body: unknown = await response.json();
        if (!response.ok || !body || typeof body !== "object" || Array.isArray(body) || typeof (body as { uploadId?: unknown }).uploadId !== "string") {
          throw new Error("附件暂存失败");
        }
        const uploadId = (body as { uploadId: string }).uploadId;
        const subjectText = subject.value.trim(); const measurementText = measurement.value.trim();
        options.openAgentPrompt([
          `请审阅并归档本地暂存附件 ${uploadId}。`,
          `当前方案 ${planId}；期望作用域 ${scope.value}${subjectText ? `，对象 ${subjectText}` : ""}。`,
          measurementText ? `请把以下量尺/方向作为待确认观察提案：${measurementText}。` : "如果附件包含可用量尺或方向，请只提出待确认观察，不要直接写入方案。",
          "请先说明隐私处理、元数据清理、解析方式与误差，再展示需要我批准的归档和观察步骤。",
        ].join("\n"));
        status.textContent = `已暂存 ${selected.name}；请在下方 Agent 中逐项审阅并批准。`;
      } catch (cause) { status.textContent = cause instanceof Error ? cause.message : "附件暂存失败"; }
      finally { submit.disabled = false; }
    })();
  };
  form.addEventListener("submit", onSubmit);
  return { dispose() { form.removeEventListener("submit", onSubmit); host.replaceChildren(); } };
}
