/**
 * 开源资源汇种子数据（共 93 条）。
 *
 * 来源：用户从抖音/微信/GitHub 收集、经豆包整合的「开源模型&技能汇总表」。
 * category 为顶层分类（卡片筛选用），subcategory 保留原表的细分口径。
 * 本文件由 scripts 解析生成（见 tmp-parse-resources.cjs 的历史版本），手工新增条目请直接追加。
 */
export interface ResourceSeed {
  name: string
  category: string
  subcategory: string
  description: string
  link: string | null
  links?: string[]
}

export const RESOURCE_SEED: ResourceSeed[] = [
  {
    "name": "science‑research‑writing‑skill",
    "category": "科研与论文",
    "subcategory": "科研论文技能",
    "description": "科研论文逻辑结构优化，逐句定位写作作用，排查文献堆砌、结果讨论混淆，修正翻译腔",
    "link": null
  },
  {
    "name": "andrej‑karpathy‑skills",
    "category": "科研与论文",
    "subcategory": "科研论文技能",
    "description": "Karpathy相关AI提示词技能集，复刻顶尖AI研究者的思考与提示词编写逻辑",
    "link": "https://github.com/forrestchang/andrej-karpathy-skills",
    "links": [
      "https://github.com/forrestchang/andrej-karpathy-skills",
      "https://github.com/forrestchang/andrej-karpathy-skills"
    ]
  },
  {
    "name": "CodeGraph",
    "category": "开发与工程",
    "subcategory": "代码分析工具",
    "description": "构建代码图谱，解析代码结构、调用关系、依赖链路，辅助大型项目代码梳理",
    "link": "https://github.com/colbymchenry/codegraph",
    "links": [
      "https://github.com/colbymchenry/codegraph",
      "https://github.com/colbymchenry/codegraph"
    ]
  },
  {
    "name": "Understand‑Anything",
    "category": "知识与工具",
    "subcategory": "通用多模态工具",
    "description": "通用多模态内容解析工具，可解析文档、图片、网页、视频转录文本等各类信息",
    "link": "https://github.com/Lum1104/Understand-Anything",
    "links": [
      "https://github.com/Lum1104/Understand-Anything",
      "https://github.com/Lum1104/Understand-Anything"
    ]
  },
  {
    "name": "presenton",
    "category": "知识与工具",
    "subcategory": "文档生成工具",
    "description": "AI演示文稿生成工具，一键根据文本内容生成结构化PPT大纲、文案与排版思路",
    "link": "https://github.com/presenton/presenton",
    "links": [
      "https://github.com/presenton/presenton",
      "https://github.com/presenton/presenton"
    ]
  },
  {
    "name": "LongLive",
    "category": "知识与工具",
    "subcategory": "长文本处理技能",
    "description": "长文本上下文处理技能，突破大模型上下文窗口限制，处理超长论文、代码库、书籍文本",
    "link": null
  },
  {
    "name": "claude‑plugins‑official",
    "category": "智能体与 LLM",
    "subcategory": "LLM插件拓展",
    "description": "Claude官方拓展插件项目，为Claude模型对接第三方工具、API，扩充模型实操能力",
    "link": "https://github.com/anthropics/claude-plugins-official",
    "links": [
      "https://github.com/anthropics/claude-plugins-official",
      "https://github.com/anthropics/claude-plugins-official"
    ]
  },
  {
    "name": "gsap‑skills",
    "category": "UI 与设计",
    "subcategory": "网页动画技能",
    "description": "网页动画GSAP代码提示词技能库，快速生成GSAP动画脚本、调试动画参数",
    "link": "https://github.com/greensock/gsap-skills",
    "links": [
      "https://github.com/greensock/gsap-skills",
      "https://github.com/greensock/gsap-skills"
    ]
  },
  {
    "name": "Haojae/scipilot‑figure‑skill",
    "category": "科研与论文",
    "subcategory": "科研绘图技能",
    "description": "学术论文图表绘制技能，适配SCI/核心期刊格式规范，生成标准化科研配图、实验曲线图",
    "link": null
  },
  {
    "name": "academic-figure-skill",
    "category": "科研与论文",
    "subcategory": "科研绘图技能",
    "description": "科研专业绘图进阶技能，规范学术插图构图、配色、矢量图制作，符合期刊出版要求，可绘制流程图、机理图、示意图，和scipilot-figure-skill互为补充",
    "link": null
  },
  {
    "name": "lingbot‑map",
    "category": "其他",
    "subcategory": "地理信息技能",
    "description": "语言机器人地图定位相关技能，结合NLP实现地址解析、路线规划、地理信息问答",
    "link": null
  },
  {
    "name": "next‑ai‑draw‑io",
    "category": "知识与工具",
    "subcategory": "AI绘图工具",
    "description": "基于Next框架搭建的AI在线绘图网页端工具，支持流程图、架构图、示意图AI生成",
    "link": null
  },
  {
    "name": "sam‑3d‑body",
    "category": "AI 模型与视觉",
    "subcategory": "3D视觉项目",
    "description": "依托SAM分割模型开发的3D人体分割建模项目，完成人体点云、Mesh三维重建与分割",
    "link": null
  },
  {
    "name": "forkprobe",
    "category": "开发与工程",
    "subcategory": "代码对比工具",
    "description": "GitHub仓库分支差异、代码改动探测工具，对比Fork仓库与原库代码变更、溯源提交记录",
    "link": null
  },
  {
    "name": "good‑Badminton",
    "category": "其他",
    "subcategory": "运动辅助项目",
    "description": "羽毛球运动辅助项目，包含动作拆解、训练计划生成、赛事数据分析功能",
    "link": null
  },
  {
    "name": "mattpocock/skills",
    "category": "开发与工程",
    "subcategory": "前端编程技能",
    "description": "前端TS、TypeScript编程提示词技能库，专精前端类型体操、代码规范、工程化脚本生成",
    "link": "https://github.com/mattpocock/skills",
    "links": [
      "https://github.com/mattpocock/skills",
      "https://github.com/mattpocock/skills"
    ]
  },
  {
    "name": "imagen‑pytorch",
    "category": "AI 模型与视觉",
    "subcategory": "文生图模型",
    "description": "基于PyTorch开源复现Imagen文生图模型，可本地部署实现高精度文本生成图像",
    "link": "https://github.com/lucidrains/imagen-pytorch",
    "links": [
      "https://github.com/lucidrains/imagen-pytorch",
      "https://github.com/lucidrains/imagen-pytorch"
    ]
  },
  {
    "name": "world‑model‑method",
    "category": "智能体与 LLM",
    "subcategory": "LLM思考技能",
    "description": "世界模型思考方法提示词技能，参考Yann LeCun世界模型理论，让AI具备推演式规划思考能力",
    "link": null
  },
  {
    "name": "SIT‑shushu internship‑tool（鼠鼠实习妙妙工具）",
    "category": "其他",
    "subcategory": "求职辅助技能",
    "description": "AI求职技能工具包，输入岗位JD自动生成匹配项目经历、优化简历内容、模拟技术面试问答，适配计算机全方向零基础求职者",
    "link": null
  },
  {
    "name": "obsidian‑skills",
    "category": "知识与工具",
    "subcategory": "知识库技能",
    "description": "Obsidian知识库专属AI技能，引导AI调用双链、属性、Canvas、嵌入等Obsidian原生功能，实现AI管理个人知识库",
    "link": null
  },
  {
    "name": "academic-research-skills",
    "category": "科研与论文",
    "subcategory": "科研全流程技能",
    "description": "学术研究全流程技能合集，覆盖文献批量检索、选题论证、实验设计、论文润色、参考文献格式化等科研辅助能力",
    "link": "https://github.com/Imbad0202/academic-research-skills",
    "links": [
      "https://github.com/Imbad0202/academic-research-skills",
      "https://github.com/Imbad0202/academic-research-skills"
    ]
  },
  {
    "name": "paper-craft-skills",
    "category": "科研与论文",
    "subcategory": "论文加工技能",
    "description": "论文加工双核心技能库：paper-comic将论文转化专业图解/手绘笔记风配图；paper-analyzer提供故事科普、学术汇报、三分钟速读三种论文深度解读模式，可联动代码解析论文开源实现细节",
    "link": null
  },
  {
    "name": "agency-agents（含原版+汉化版agency-agents-zh）",
    "category": "智能体与 LLM",
    "subcategory": "多智能体资源",
    "description": "爆款企业级AI专家智能体库，MIT开源可商用；原版内置232个专业Agent划分16大业务部门，中文汉化版扩充至215个Agent、18个部门（新增国内电商/小红书运营本土化角色）；每个Agent配备完整人设、行业工作流程、交付模板与验收标准，支持单个专家调用或多Agent组队模拟企业流水线协作，兼容Cursor、Claude、Copilot等主流AI开发/对话工具，仅为Prompt配置库无自动调度框架，海外原生角色适配性有限",
    "link": "https://github.com/msitarzewski/agency-agents",
    "links": [
      "https://github.com/msitarzewski/agency-agents",
      "https://github.com/msitarzewski/agency-agents",
      "https://github.com/jnMetaCode/agency-agents-zh",
      "https://github.com/jnMetaCode/agency-agents-zh"
    ]
  },
  {
    "name": "Paper RAG",
    "category": "科研与论文",
    "subcategory": "科研RAG技能",
    "description": "科研论文专属检索增强生成技能，批量导入多篇PDF论文构建私有知识库，精准检索文献细节、做跨论文对比问答、提炼文献核心论据",
    "link": null
  },
  {
    "name": "Stats Sanity",
    "category": "科研与论文",
    "subcategory": "科研统计校验",
    "description": "科研统计校验技能，核查论文内实验统计方法合理性、P值/置信区间、显著性检验逻辑，排查统计造假、实验设计漏洞",
    "link": null
  },
  {
    "name": "Nature-skills",
    "category": "科研与论文",
    "subcategory": "顶刊写作技能",
    "description": "对标《Nature》期刊写作范式的科研技能库，复刻顶刊行文逻辑、摘要撰写、讨论段拔高话术，适配高分SCI投稿润色",
    "link": null
  },
  {
    "name": "PaperSpine",
    "category": "科研与论文",
    "subcategory": "论文拆解技能",
    "description": "论文骨架拆解技能，自动抽取论文的研究脉络主线（研究痛点-方案设计-实验验证-结论贡献），梳理论文完整逻辑主干，辅助写综述、复现研究思路",
    "link": null
  },
  {
    "name": "LaTeX Writer",
    "category": "科研与论文",
    "subcategory": "LaTeX写作技能",
    "description": "专业LaTeX论文编写技能，一键生成期刊模板格式的LaTeX代码、公式排版、参考文献BibTex配置，适配IEEE、Elsevier等主流期刊模板",
    "link": null
  },
  {
    "name": "Cite Verify",
    "category": "科研与论文",
    "subcategory": "引文校验技能",
    "description": "引文核验技能，批量核查参考文献引用正误、引文与正文论点匹配度、漏引/错引问题，规避投稿引文审核翻车",
    "link": null
  },
  {
    "name": "Repro Pack",
    "category": "科研与论文",
    "subcategory": "实验复现技能",
    "description": "实验可复现打包技能，梳理论文实验环境、代码依赖、数据集调用逻辑，生成完整可复现的工程打包清单，辅助代码复现、实验复刻",
    "link": null
  },
  {
    "name": "Survey Builder",
    "category": "科研与论文",
    "subcategory": "综述撰写技能",
    "description": "综述论文搭建技能，自动聚类同领域文献、梳理研究发展时间线、划分技术流派，辅助搭建综述整体框架与章节排布",
    "link": null
  },
  {
    "name": "Grant Writer",
    "category": "科研与论文",
    "subcategory": "基金标书技能",
    "description": "科研基金标书撰写技能，适配国自然、省市级课题等申报逻辑，生成立项依据、研究方案、可行性分析、经费预算等标书模块内容",
    "link": null
  },
  {
    "name": "Supervisor-Skills",
    "category": "科研与论文",
    "subcategory": "科研导师技能",
    "description": "港科教授10年博导经验蒸馏的AI科研副导师技能，提供科研入门PDF覆盖idea构建、写作、做图、实战全流程，支持直接调用完成科研任务，适配研0或散养型导师场景",
    "link": null
  },
  {
    "name": "photo-abstract-editorial",
    "category": "科研与论文",
    "subcategory": "论文配图技能",
    "description": "配图摘要编辑专项技能，针对论文配图、图文摘要做版式精修、文字排版优化、视觉风格调校，适配期刊图文摘要、封面配图的编辑出版规范",
    "link": null
  },
  {
    "name": "lieflat charts",
    "category": "UI 与设计",
    "subcategory": "前端可视化",
    "description": "开源轻量级图表组件库，主打零配置、AI友好；可被Vibe‑Coding类AI一键生成各类折线图、柱状图、饼图、雷达图；代码简洁无冗余，开箱即用，适配React/Vue、Tailwind技术栈，适合AI快速产出数据看板页面",
    "link": "https://github.com/larashero3-dotcom/lieflat-charts",
    "links": [
      "https://github.com/larashero3-dotcom/lieflat-charts",
      "https://github.com/larashero3-dotcom/lieflat-charts"
    ]
  },
  {
    "name": "Taste Skill（味觉技巧）",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑技能",
    "description": "注入视觉审判系统，依据设计原则自我审查，提升界面高级感；支持React、Vue、Svelte三大主流框架，GitHub超6.3万星，矫正AI常见留白、配色、层级脏乱问题",
    "link": "https://github.com/Leonxlnx/taste-skill",
    "links": [
      "https://github.com/Leonxlnx/taste-skill",
      "https://github.com/Leonxlnx/taste-skill"
    ]
  },
  {
    "name": "Impeccable",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑技能",
    "description": "内置23个核心命令和设计反模式词典，明确设计避坑点，拦截过度圆角、无效渐变、排版失衡等问题；生成代码完整且具备大厂高级质感，支持全局设计规范初始化",
    "link": "https://github.com/pbakaus/impeccable",
    "links": [
      "https://github.com/pbakaus/impeccable",
      "https://github.com/pbakaus/impeccable"
    ]
  },
  {
    "name": "ui‑ux‑pro‑max‑skill",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑技能",
    "description": "支持8种技术栈+8个前端框架，专治AI生成界面丑陋、布局杂乱、无法自定义配色等痛点，GitHub超7.4万星",
    "link": "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
    "links": [
      "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill",
      "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill"
    ]
  },
  {
    "name": "Landing Love",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "主打网页高级交互动效、轻量动画参考，为AI编程提供高质量动态交互审美范本",
    "link": null
  },
  {
    "name": "Landbook",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "主打轻奢、极简、高级质感商业页面案例，专门训练AI高端品牌级视觉审美",
    "link": null
  },
  {
    "name": "Awwwards",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "全网顶级获奖网页合集，前沿排版、光影、动效、布局标杆，用于拉高AI设计上限",
    "link": null
  },
  {
    "name": "One Page Love",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "海量极简单页网站模板，强化AI干净、克制、留白合理的极简设计逻辑",
    "link": null
  },
  {
    "name": "Mobbin",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "海量移动端APP完整界面+交互流程案例，专攻移动端UI、手势、转场、组件规范",
    "link": null
  },
  {
    "name": "Lapa Ninja",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "炫酷视觉特效、粒子、渐变、光影页面合集，丰富AI特效制作能力",
    "link": null
  },
  {
    "name": "Framer Gallery",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "高质量无代码模板库，可直接复刻结构、动效、排版，提升AI落地还原度",
    "link": null
  },
  {
    "name": "Aceternity UI",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "200+开箱即用高级UI组件、悬浮特效、Bento布局，数十万开发者使用，快速搭建标准化高级界面",
    "link": "https://github.com/aceternity-ui/aceternity-ui",
    "links": [
      "https://github.com/aceternity-ui/aceternity-ui",
      "https://github.com/aceternity-ui/aceternity-ui"
    ]
  },
  {
    "name": "21st",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "成套风格化模板库，一键套用现代、极简、赛博、商务等多种风格",
    "link": null
  },
  {
    "name": "Siteinspire",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "极致排版、细节质感、留白体系标杆，训练AI精细化页面细节把控能力",
    "link": null
  },
  {
    "name": "React Bits",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "开源免费，上百种高级动效组件：星空、解码文字、流光、发光边框等，开箱即用",
    "link": "https://github.com/DavidHDev/react-bits",
    "links": [
      "https://github.com/DavidHDev/react-bits",
      "https://github.com/DavidHDev/react-bits"
    ]
  },
  {
    "name": "Uiverse.io",
    "category": "UI 与设计",
    "subcategory": "UI设计与审美提升类‑设计网站",
    "description": "4000+免费开源UI元素，按钮、卡片、表单、动画全覆盖，快速填充页面基础组件",
    "link": "https://github.com/sheryldesign/uiverse",
    "links": [
      "https://github.com/sheryldesign/uiverse",
      "https://github.com/sheryldesign/uiverse"
    ]
  },
  {
    "name": "Ponytail（马尾辫）",
    "category": "开发与工程",
    "subcategory": "代码优化与规范类",
    "description": "六道前置逻辑校验，消除AI代码冗余，最高缩减94%代码量，编译与生成速度提升3–6倍，大幅降低维护成本",
    "link": "https://github.com/DietrichGebert/ponytail",
    "links": [
      "https://github.com/DietrichGebert/ponytail",
      "https://github.com/DietrichGebert/ponytail"
    ]
  },
  {
    "name": "Anthony Fu的技能合集",
    "category": "开发与工程",
    "subcategory": "代码优化与规范类",
    "description": "Vite、Nuxt、Vue生态官方最佳实践合集，自动规范项目结构、配置、写法，杜绝不规范代码",
    "link": "https://github.com/antfu/skills",
    "links": [
      "https://github.com/antfu/skills",
      "https://github.com/antfu/skills"
    ]
  },
  {
    "name": "高德地图‑Skill",
    "category": "开发与工程",
    "subcategory": "特定领域集成类",
    "description": "内置高德地图JS API 2.0全套规范与模板，AI一键生成合规、可直接上线的地图业务代码",
    "link": "https://github.com/AMap-Web/amap-skills",
    "links": [
      "https://github.com/AMap-Web/amap-skills",
      "https://github.com/AMap-Web/amap-skills"
    ]
  },
  {
    "name": "Codex 前端交付技能",
    "category": "开发与工程",
    "subcategory": "项目交付与落地类",
    "description": "覆盖前端全流程交付规范、上线避坑、兼容性处理、工程化标准，杜绝上线翻车",
    "link": null
  },
  {
    "name": "Obsidian‑skills",
    "category": "知识与工具",
    "subcategory": "知识库与AI协作类",
    "description": "Obsidian官方创始人开源技能，让AI支持双链、嵌入、属性、Canvas、检索联动，搭建AI个人知识库体系，GitHub超3.7万星",
    "link": "https://github.com/kepano/obsidian-skills",
    "links": [
      "https://github.com/kepano/obsidian-skills",
      "https://github.com/kepano/obsidian-skills"
    ]
  },
  {
    "name": "agency‑agents（原版+汉化版GitHub项目）",
    "category": "智能体与 LLM",
    "subcategory": "AI多智能体团队协作资源",
    "description": "拥有200+职业智能体，覆盖产品、开发、设计、营销、运营；可模拟完整企业团队协作；支持Claude、Cursor、Copilot，汉化版适配国内场景",
    "link": "https://github.com/msitarzewski/agency-agents",
    "links": [
      "https://github.com/msitarzewski/agency-agents",
      "https://github.com/msitarzewski/agency-agents",
      "https://github.com/jnMetaCode/agency-agents-zh",
      "https://github.com/jnMetaCode/agency-agents-zh"
    ]
  },
  {
    "name": "awesome‑llm‑apps",
    "category": "智能体与 LLM",
    "subcategory": "LLM应用开源合集资源",
    "description": "GitHub顶级LLM项目合集，按RAG、智能体、语音、绘图、自动化精细分类，可直接部署复刻",
    "link": "https://github.com/Shubhamsaboo/awesome-llm-apps",
    "links": [
      "https://github.com/Shubhamsaboo/awesome-llm-apps",
      "https://github.com/Shubhamsaboo/awesome-llm-apps"
    ]
  },
  {
    "name": "Remotion Skill（零基础简化版）",
    "category": "视频创作",
    "subcategory": "可编程AI视频制作类",
    "description": "基于React的可编程视频框架，无需精通前端即可AI批量生成解说、字幕、数据短视频，支持MP4精准渲染",
    "link": "https://github.com/remotion-dev/skills",
    "links": [
      "https://github.com/remotion-dev/skills",
      "https://github.com/remotion-dev/skills"
    ]
  },
  {
    "name": "InsForge",
    "category": "开发与工程",
    "subcategory": "AI专属后端基础设施",
    "description": "AI Agent专用BaaS后端，对标Supabase，AI可全自动建表、部署接口、存储、权限、网关，无需人工运维",
    "link": "https://github.com/InsForge/InsForge",
    "links": [
      "https://github.com/InsForge/InsForge",
      "https://github.com/InsForge/InsForge"
    ]
  },
  {
    "name": "AgentChat（微软AutoGen核心模块）",
    "category": "智能体与 LLM",
    "subcategory": "多智能体编排框架",
    "description": "工业级多智能体调度，自动分工、对话协商、并发任务、批量处理文档与数据，支持多模型混合调用",
    "link": "https://github.com/microsoft/autogen",
    "links": [
      "https://github.com/microsoft/autogen",
      "https://github.com/microsoft/autogen"
    ]
  },
  {
    "name": "anime.js",
    "category": "UI 与设计",
    "subcategory": "网页动效开发类",
    "description": "轻量JS动画引擎，实现轻量化丝滑过渡、形变、滚动动画，适配所有前端项目",
    "link": "https://github.com/juliangarnier/anime",
    "links": [
      "https://github.com/juliangarnier/anime",
      "https://github.com/juliangarnier/anime"
    ]
  },
  {
    "name": "GSAP（GreenSock Animation Platform）",
    "category": "UI 与设计",
    "subcategory": "网页动效开发类",
    "description": "行业顶级高性能动画库，支持3D、路径、时间轴精准控制、高级滚动视差，用于电影级网页动效",
    "link": "https://github.com/greensock/GSAP",
    "links": [
      "https://github.com/greensock/GSAP",
      "https://github.com/greensock/GSAP"
    ]
  },
  {
    "name": "interview‑coach‑skill",
    "category": "其他",
    "subcategory": "求职面试辅助类",
    "description": "AI面试教练，简历解析、岗位匹配、模拟追问、回答评分、面试复盘、薪资谈判全流程辅助",
    "link": null
  },
  {
    "name": "video‑shotcraft",
    "category": "视频创作",
    "subcategory": "电影级宣传片制作类",
    "description": "106套镜头配方、161种电影级动效，AI一键生成产品宣传片、品牌短片，支持模板出片与自定义运镜",
    "link": "https://github.com/Vincentwei1021/video-shotcraft",
    "links": [
      "https://github.com/Vincentwei1021/video-shotcraft",
      "https://github.com/Vincentwei1021/video-shotcraft"
    ]
  },
  {
    "name": "scroll‑world",
    "category": "UI 与设计",
    "subcategory": "3D滚动网站开发类",
    "description": "AI一键生成3D滚动叙事官网，实现滚动穿越式立体场景，适配品牌页、招商页、产品故事页，低成本打造顶级视觉官网",
    "link": "https://github.com/oso95/scroll-world",
    "links": [
      "https://github.com/oso95/scroll-world",
      "https://github.com/oso95/scroll-world"
    ]
  },
  {
    "name": "AI‑SkillHub（Skill高级管理工具）",
    "category": "知识与工具",
    "subcategory": "AI技能管理工具",
    "description": "Windows端AI技能总管，统一管理所有Skill、提示词、模板；软链接多AI客户端同步更新，支持版本、星级、检索、调用统计，彻底解决多端技能散乱",
    "link": null
  },
  {
    "name": "PenguinHarness（企鹅驾驭师）",
    "category": "智能体与 LLM",
    "subcategory": "Agent自进化框架类",
    "description": "全自动Agent构建与迭代平台，自然语言生成完整智能体工程，内置评测体系自主迭代，大幅降低大模型智能体开发成本",
    "link": "https://github.com/Prism-Shadow/penguin-harness",
    "links": [
      "https://github.com/Prism-Shadow/penguin-harness",
      "https://github.com/Prism-Shadow/penguin-harness"
    ]
  },
  {
    "name": "Rebucca",
    "category": "AI 模型与视觉",
    "subcategory": "计算机视觉/视频分析开源项目",
    "description": "开源智能视频监控与AI行为分析平台，MIT免费商用；支持RTSP/GB28181/ONVIF全协议摄像头接入、自动设备发现；集成YOLO目标追踪、区域入侵、越线、滞留、密度六大布控规则；支持CPU轻量化部署、大小模型双复核降误报，全架构适配，适合安防、边缘AI二次开发",
    "link": "https://github.com/beixiaocai/rebucca",
    "links": [
      "https://github.com/beixiaocai/rebucca",
      "https://github.com/beixiaocai/rebucca"
    ]
  },
  {
    "name": "LocateAnything‑3B",
    "category": "AI 模型与视觉",
    "subcategory": "计算机视觉‑开源视觉模型",
    "description": "英伟达开源的30亿参数轻量级多模态视觉定位模型，采用并行框解码（PBD）技术，可通过自然语言描述在图像/视频中精准定位目标，支持开放词汇检测，无需提前定义固定类别，吞吐量较传统方法提升2.5倍，可同时实现目标检测、OCR文字定位、GUI元素定位等功能",
    "link": "https://github.com/NVlabs/Eagle/tree/main/Embodied",
    "links": [
      "https://github.com/NVlabs/Eagle/tree/main/Embodied",
      "https://github.com/NVlabs/Eagle/tree/main/Embodied"
    ]
  },
  {
    "name": "Jev（System One Model，系统一模型）",
    "category": "AI 模型与视觉",
    "subcategory": "实时决策AI模型",
    "description": "TypeSafe AI开发，高速结构化决策模型，适合机器人/自动驾驶/仿真实时循环，仅输出带置信度结构化结果，不生成自由文本；采用RLCD校准决策强化学习，让置信度匹配真实正确率；仅3种输出原语：Choice候选选择+概率、Score区间打分+置信度、Noul布尔概率判断；非自回归单次并行推理，强Schema约束消除格式幻觉，延迟70~500ms，比通用LLM快几十上百倍，单次调用并行回答多问题；适用实时控制系统、自动驾驶决策、智能体状态判断、视频事件判定、监控告警分流、仿真智能决策；权重未开源，仅开放API，社区存在非官方jevlike简易复刻；局限：无法自由文本创作，不适合系统二复杂长链推理，不能本地离线部署",
    "link": null
  },
  {
    "name": "CARLA Simulator（Car Learning to Act）",
    "category": "AI 模型与视觉",
    "subcategory": "自动驾驶仿真平台",
    "description": "开源自动驾驶城市仿真平台，基于虚幻引擎UE4/UE5，适配轨迹预测论文闭环验证；MIT协议，科研可免费商用；架构采用Server-Client分离，Server负责虚幻渲染与物理仿真，Client使用Python/C++ API开发算法；内置Town01~Town12多地图、OpenDRIVE道路资产，搭载RGB/深度/语义相机、LiDAR、RADAR、IMU/GNSS等传感器，支持自定义传感器噪声；配套ScenarioRunner自定义危险场景、TrafficManager车流控制、ROS/ROS2桥接；Windows推荐版本0.9.15/0.9.16，0.9.11为轨迹预测常用基线版本；可直接导出所有智能体历史位姿、GT未来轨迹，数据集可转nuScenes格式，用于MTR、QCNet等轨迹预测模型训练与闭环评估；可构建长尾危险交互场景，联动Jev决策层做不确定性安全校验；局限：原生TrafficManager车辆交互偏规则化，存在仿真域差，适合小规模消融、场景验证，不适合百万级大数据训练",
    "link": "https://github.com/carla-simulator/carla",
    "links": [
      "https://github.com/carla-simulator/carla",
      "https://github.com/carla-simulator/carla"
    ]
  },
  {
    "name": "needle",
    "category": "AI 模型与视觉",
    "subcategory": "轻量边缘模型",
    "description": "8-29MB超轻量AI模型，基于Simple Attention Network架构，2-bit量化；支持工具调用、结构化抽取、文本嵌入；可在手机、手表、单片机离线运行；Apache 2.0开源",
    "link": "https://github.com/cactus-compute/needle",
    "links": [
      "https://github.com/cactus-compute/needle",
      "https://github.com/cactus-compute/needle"
    ]
  },
  {
    "name": "SAM3（Segment Anything Model 3）",
    "category": "AI 模型与视觉",
    "subcategory": "图像视频分割模型",
    "description": "Meta第三代分割基础模型，PCS概念提示分割；支持文本/样本图/混合提示；图像、视频目标分割+实例ID跟踪；统一骨干，H200上单图推理30ms，支持100+目标；附带SA-Co评测基准，开源权重与推理代码；适用自动驾驶、机器人、视频编辑、工业视觉",
    "link": "https://github.com/facebookresearch/sam3",
    "links": [
      "https://github.com/facebookresearch/sam3",
      "https://github.com/facebookresearch/sam3"
    ]
  },
  {
    "name": "VLX-Seek（VLX-Seek 1.5）",
    "category": "AI 模型与视觉",
    "subcategory": "端侧细粒度视觉模型",
    "description": "Om AI Lab（联汇科技）出品，端侧原生具身视觉多模态模型；核心HFRE混合细粒度区域编码器，将目标定位转为区域引用而非坐标生成；提供0.6B/3B/10B多尺寸版本；支持视频流实时输入，细粒度目标定位、指代理解、目标计数；大幅降低幻觉，无人机、机器人、机器狗、监控检测场景表现优异；为VLX三层端侧大脑中的定位模块，开源权重与推理代码",
    "link": "https://github.com/om-ai-lab",
    "links": [
      "https://github.com/om-ai-lab",
      "https://github.com/om-ai-lab"
    ]
  },
  {
    "name": "RelateAnything",
    "category": "AI 模型与视觉",
    "subcategory": "计算机视觉-视觉关系模型",
    "description": "53M参数轻量级实时开放词汇视觉关系预测模型，单帧处理仅需20ms；支持1.9万关系词免重训，无需提前定义物体类别，可直接预测图像/视频中物体间主谓宾交互关系；可对接任意检测器/分割器输出的区域，返回带置信度的关系排序结果；适配具身智能、机器人、自动驾驶、视频场景理解等场景，开源权重与推理代码",
    "link": "https://github.com/Maelic/RelateAnything",
    "links": [
      "https://github.com/Maelic/RelateAnything",
      "https://github.com/Maelic/RelateAnything"
    ]
  },
  {
    "name": "WeKnora",
    "category": "知识与工具",
    "subcategory": "企业RAG框架",
    "description": "腾讯开源企业级RAG知识平台，MIT协议；三大核心能力：RAG快速问答、ReAct Agent智能推理、自动Wiki模式；支持飞书、Notion、语雀、RSS多源数据定时同步；兼容20+主流大模型，支持私有化本地部署；企业级能力：多工作区权限、审计日志、全链路可观测；支持PDF、Word、Excel、PPT、Markdown、图片、音频多格式文档；后端Go，前端Vue3+TS，可Docker/K8s部署",
    "link": "https://github.com/Tencent/WeKnora",
    "links": [
      "https://github.com/Tencent/WeKnora",
      "https://github.com/Tencent/WeKnora"
    ]
  },
  {
    "name": "Lot Vulture",
    "category": "AI 模型与视觉",
    "subcategory": "计算机视觉-车位检测项目",
    "description": "RTSP摄像头本地部署AI车位检测系统，自托管；基于Meta DINO模型，搭配Blender生成合成数据混合真实数据训练，解决车辆遮挡识别难题；难样本识别准确率99.09%；支持MQTT/邮件告警，可对接诱导屏，无需地磁硬件",
    "link": null
  },
  {
    "name": "moto-gps-waveshare",
    "category": "其他",
    "subcategory": "硬件项目",
    "description": "摩托车GPS定位项目，基于Waveshare微雪GNSS/GPS模组开发；仓库404无法访问，推测仓库已删除/私有/重命名",
    "link": "https://github.com/mx3353672833-debug/moto-gps-waveshare",
    "links": [
      "https://github.com/mx3353672833-debug/moto-gps-waveshare",
      "https://github.com/mx3353672833-debug/moto-gps-waveshare"
    ]
  },
  {
    "name": "Colibri",
    "category": "开发与工程",
    "subcategory": "大模型推理引擎",
    "description": "纯C实现、零外部依赖的MoE大模型推理引擎；基于SSD按需流式加载专家权重，无需将完整模型载入内存，家用电脑（最低16GB内存）即可本地跑744B GLM-5.2，还支持Kimi K3、DeepSeek V4等大模型；支持CUDA/Metal加速，专家自动缓存，双SSD带宽叠加；推理速度偏慢，适合验证超大MoE模型本地可行性",
    "link": "https://github.com/JustVugg/colibri",
    "links": [
      "https://github.com/JustVugg/colibri",
      "https://github.com/JustVugg/colibri"
    ]
  },
  {
    "name": "MediaCrawler",
    "category": "知识与工具",
    "subcategory": "数据采集工具",
    "description": "多平台社交媒体数据采集开源项目，GitHub星标6万+；支持抖音、小红书、快手、B站、微博、知乎、贴吧等平台；采集内容包含视频、图片、评论、点赞、转发；基于Playwright浏览器自动化，无需复杂逆向，支持登录态缓存、IP代理池、评论词云生成；输入关键词即可采集，上手门槛低",
    "link": "https://github.com/NanmiCoder/MediaCrawler",
    "links": [
      "https://github.com/NanmiCoder/MediaCrawler",
      "https://github.com/NanmiCoder/MediaCrawler"
    ]
  },
  {
    "name": "GTR (Gated Token Recurrence)",
    "category": "AI 模型与视觉",
    "subcategory": "计算机视觉-视觉骨干模型",
    "description": "无softmax循环视觉骨干网络，结合门控线性注意力、交替空间扫描方向、空间增强SwiGLU块；无需softmax，计算复杂度线性化；基于DINOv3蒸馏训练；RTX4090 FP16编译推理延迟1.908ms，COCO val2017 box AP 58.9；CUDA算子比FLA v0.5.0快4倍；适用于实例分割、姿态估计、目标检测、语义分割、单目深度估计",
    "link": null
  },
  {
    "name": "flash-linear-attention",
    "category": "开发与工程",
    "subcategory": "线性注意力工具库",
    "description": "基于Triton的线性注意力实现集合，纯PyTorch+Triton编写，支持NVIDIA/AMD/Intel多平台；可直接替换标准多头注意力，兼容HuggingFace Transformers，支持RULER基准测试；用于大模型训练、扩散模型、视觉Transformer加速",
    "link": null
  },
  {
    "name": "HorizonStream",
    "category": "AI 模型与视觉",
    "subcategory": "3D重建研究框架",
    "description": "基于证据影响核的流式3D重建框架，统一长期时间记忆和短期空间匹配；提出几何线性注意力，等价于折扣测试时训练；24层Transformer骨干、交替帧块结构；适合长时序视觉映射、流式3D重建",
    "link": null
  },
  {
    "name": "LongStream",
    "category": "AI 模型与视觉",
    "subcategory": "视觉几何框架",
    "description": "长序列流式自回归视觉几何框架，基于VGGT初始化，采用缓存一致性KV缓存训练；1.3B参数24层骨干，交替全局和帧级注意力，解决长序列注意力崩溃；用于长视频3D重建、视觉几何任务",
    "link": null
  },
  {
    "name": "SANA-WM",
    "category": "AI 模型与视觉",
    "subcategory": "视频世界模型",
    "description": "2.6B参数开源世界模型，混合门控DeltaNet（GDN）+softmax注意力骨干；单GPU生成分钟级720p视频；循环状态保持固定尺寸，解决内存爆炸；20个Transformer块，15个帧级GDN块+5个softmax注意力块；用于视频生成、世界模型构建",
    "link": null
  },
  {
    "name": "AuroraLong",
    "category": "AI 模型与视觉",
    "subcategory": "长视频多模态架构",
    "description": "高效开放视频理解架构，RWKV-v6-Finch线性RNN替代Transformer LLM骨干；恒定内存复杂度，支持任意序列长度；SigLIP视觉编码器+两层MLP跨模态连接器，训练无需重排序；用于长视频理解、多模态大模型优化",
    "link": null
  },
  {
    "name": "Anchor3R",
    "category": "AI 模型与视觉",
    "subcategory": "长时序SLAM框架",
    "description": "面向长时序视觉映射的流式3D重建框架，引入瞬态锚点；每5帧选关键帧，NetVLAD检索相似图像；以当前帧为中心预测，注意力分布均衡；适用于长时序视觉SLAM、3D重建",
    "link": null
  },
  {
    "name": "CausalDrive",
    "category": "AI 模型与视觉",
    "subcategory": "自动驾驶世界模型",
    "description": "自动驾驶实时因果世界模型，Context-Forced DMD架构；基于前视图、自车轨迹、文本提示运行；排除未来NPC布局，文本驱动驾驶交互，12FPS交互速度；用于自动驾驶仿真、强化学习后训练",
    "link": null
  },
  {
    "name": "TORE",
    "category": "AI 模型与视觉",
    "subcategory": "人体网格恢复框架",
    "description": "Transformer高效人体网格恢复框架，提出Token Reduction策略；利用3D几何与2D图像特征减少token冗余，分层查询身体token，Neural Shape Regressor推断网格；用于人体姿态估计、网格恢复",
    "link": null
  },
  {
    "name": "PyTorch FlexAttention",
    "category": "开发与工程",
    "subcategory": "PyTorch注意力组件",
    "description": "PyTorch2.5+内置灵活注意力组件，Python编写注意力变体，自动编译高性能代码；自定义注意力逻辑，性能对标FlashAttention，科研友好，快速验证新注意力机制；用于注意力机制研究、模型加速",
    "link": "https://github.com/pytorch/pytorch",
    "links": [
      "https://github.com/pytorch/pytorch",
      "https://github.com/pytorch/pytorch"
    ]
  },
  {
    "name": "xFormers",
    "category": "开发与工程",
    "subcategory": "Transformer加速库",
    "description": "Meta模块化Transformer加速库，多种内存高效注意力实现；算子组合灵活，广泛用于大模型训练、扩散生成；高性能注意力工具箱，用于Transformer模型优化、多任务加速",
    "link": "https://github.com/facebookresearch/xformers",
    "links": [
      "https://github.com/facebookresearch/xformers",
      "https://github.com/facebookresearch/xformers"
    ]
  },
  {
    "name": "SToRe3D",
    "category": "AI 模型与视觉",
    "subcategory": "自动驾驶3D检测论文框架",
    "description": "面向自动驾驶多视角3D目标检测稀疏框架，联合选择2D图像token+3D目标查询，存储再激活机制，检测对齐+规划对齐双监督；在nuScenes上ViT-B骨干可达到18FPS，精度损失极小；配套nuScenes-Relevance评测基准",
    "link": null
  },
  {
    "name": "REA（Reverse Engineer Anything / morluto/rea）",
    "category": "开发与工程",
    "subcategory": "逆向工程框架",
    "description": "AI驱动自动逆向代码框架，MIT协议；支持二进制、JS/Electron、.NET、网页多类型逆向；MCP协议对接Cursor/Claude Code；自动提取伪代码、汇编、调用图，本地沙箱执行，零幻觉；可对接Ghidra/IDA/Hopper；npx rea-agents setup一键部署",
    "link": "https://github.com/morluto/rea",
    "links": [
      "https://github.com/morluto/rea",
      "https://github.com/morluto/rea"
    ]
  }
]
