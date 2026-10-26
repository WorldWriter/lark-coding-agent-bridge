# 工具参数

调用格式：`python3 <skill目录>/scripts/product_rag.py TOOL --args 'JSON对象'`。
所有调用只读本机配置中的固定镜像。参数区分大小写，未知参数会失败。

| TOOL | 参数与默认值 |
|---|---|
| `get_product_kb_status` | 无 |
| `query_products` | `line` 必填 private/fcn；`filters={}`、`sort=""`、`top=10`（最多20）、`columns=null`、`includeEnded=false` |
| `find_products_by_entity` | `entity` 必填；`kind="any"`（underlying/issuer/strategy/manager/any）、`line="any"`、`top=20` |
| `browse_product_tree` | `line="any"`、`product_id=""`、`period=""`、`latest=false`、`offset=0`、`limit=50` |
| `search_product_knowledge` | `query` 必填；`line="any"`、`product_id=""`、`period=""`、`latest=false`、`top=8` |
| `grep_product_docs` | `pattern` 必填，精确短语而非正则；`line="any"`、`product_id=""`、`top=8` |
| `read_product_doc` | `doc_id` 必填；`start_page=1`、`end_page=null`、`char_offset=0` |

`period` 格式 YYYY-MM。`latest=true` 选每产品、每材料类别里已标注年月的最新文件；未标年月的 FCN 模板或季度报告应直接查目录，不能只凭 latest 判断不存在。目录有 offset/limit，搜索有 top 限制。

## 常用 facts 字段

- FCN：product_id、name、status、currency、product_mix、coupon_pa、ki_pct、ko_pct、strike_pct、tenor_months、issuer、underlying_codes、min_investment、risk_level。
- 私募：product_id、name、name_cn、manager、strategy、subscription_status、risk_level、currency、as_of、latest_doc_period、doc_count、metrics.return_1m、metrics.return_12m、metrics.return_ytd。
- filters 特殊键：keyword（名称关键词）、underlying（标的别名）。值可以是标量、列表或 `{ "gte": 10 }`；支持 eq/ne/in/gte/lte/gt/lt/contains/prefix。
- sort 示例：`coupon_pa desc`。注意 unknownColumns / readError；有错误不能把部分筛选结果当完整结果。
- coupon_pa、KI、KO、strike 和回报字段已经是百分数，不再乘 100。KI/KO/strike 以初始价格为 100。

## 参数例子

私募按名称发现：
```json
{"line":"private","filters":{"keyword":"基金名称"},"top":5}
```

FCN 已知历史批次：
```json
{"line":"fcn","filters":{"product_id":"实际批次编号"},"includeEnded":true}
```

产品材料目录：
```json
{"product_id":"上一步返回的产品ID","line":"private","latest":true}
```

按正文找赎回条款（无命中时换简短关键词或英文，不要机械重复长问句）：
```json
{"query":"赎回","product_id":"已确认的产品ID","top":5}
```

读原始 PDF 第 2 至 3 页：
```json
{"doc_id":"目录返回的doc_id","start_page":2,"end_page":3}
```
