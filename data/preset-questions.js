/**
 * 预设问题集 · Alexa 产品洞察 · WaytoAIC
 *
 * 设计原则：
 * - 通用：措辞不绑定特定品类，任何 Amazon 商品都能问。
 * - 全面：覆盖差评/好评/质量/功能/易用/尺寸/竞品/价格/人群/顾虑/FAQ/售后/物流/品牌/改进 共 15 个角度。
 * - 可深挖：每个分类是一组可独立勾选的问题；「核心必问」是跨角度的精选汇总。
 *
 * 用户可在弹窗里自定义、或用「自定义问题」补充。
 */

const PRESET_QUESTIONS = {
  summary_all: {
    id: 'summary_all',
    name: '⭐ 核心必问 / Essentials',
    nameShort: '核心必问',
    icon: '⭐',
    description: '跨所有角度精选的 24 个高价值问题，一次拿到产品全貌（比逐个分类更快）',
    questions: [
      "What are the most common complaints in the negative reviews for this product?",
      "What specific defects or quality failures do 1-star and 2-star reviewers report?",
      "Do customers feel the listing photos or description are misleading versus what arrived?",
      "How soon do customers say this product breaks, wears out, or stops working?",
      "What do customers love most about this product?",
      "Which features or qualities are praised most often in 5-star reviews?",
      "What materials is this product made of, and how is the build quality?",
      "How durable is it over months of regular use, according to reviews?",
      "What are the main features and selling points of this product?",
      "Which advertised features actually work well in real use, and which disappoint?",
      "How easy is this product to set up and start using?",
      "What do customers find confusing or frustrating when first using it?",
      "What are the exact dimensions, weight, and capacity of this product?",
      "Do customers find the size, fit, or measurements accurate to the listing?",
      "How does this product compare to the top-rated alternatives in its category?",
      "Where do competing products clearly do better than this one?",
      "Do customers feel this product is worth the price?",
      "Who is this product best suited for, and who should avoid it?",
      "What concerns or doubts make shoppers hesitate to buy this product?",
      "What do customers wish they had known before buying it?",
      "What warranty does it come with, and how is the seller's customer service?",
      "Do customers report shipping damage, missing parts, or packaging problems?",
      "What is this brand's reputation, and do buyers trust it?",
      "What improvements do customers most often wish this product had?"
    ]
  },
  negative_reviews: {
    id: 'negative_reviews',
    name: '👎 差评痛点 / Negative Pain Points',
    nameShort: '差评痛点',
    icon: '👎',
    description: '深挖差评里的抱怨、缺陷与落差，找竞品突破口',
    questions: [
      "What are the most common complaints in the negative reviews for this product?",
      "What specific defects or quality failures do 1-star and 2-star reviewers report?",
      "Do customers feel the listing photos or description are misleading versus what arrived?",
      "How soon do customers say this product breaks, wears out, or stops working?",
      "What features do customers say are missing, poorly designed, or hard to use?",
      "Are there any safety concerns or hazards raised in the reviews?",
      "What problems do reviewers mention that the seller never fixed across versions?",
      "What do disappointed customers wish they had bought instead?"
    ]
  },
  positive_drivers: {
    id: 'positive_drivers',
    name: '👍 好评驱动 / What Customers Love',
    nameShort: '好评驱动',
    icon: '👍',
    description: '找出 5 星好评里反复被夸的点，提炼卖点与买点',
    questions: [
      "What do customers love most about this product?",
      "Which features or qualities are praised most often in 5-star reviews?",
      "What pleasant surprises or unexpected benefits do reviewers mention?",
      "What makes customers say they would buy it again or recommend it?",
      "Which specific use cases get the most enthusiastic feedback?"
    ]
  },
  quality_durability: {
    id: 'quality_durability',
    name: '🔍 质量耐用 / Quality & Durability',
    nameShort: '质量耐用',
    icon: '🔍',
    description: '材质、做工、耐用度与单位间一致性',
    questions: [
      "What materials is this product made of, and how is the build quality?",
      "How durable is it over months of regular use, according to reviews?",
      "How does its quality compare to others in the same price range?",
      "Are there recurring quality-control or consistency issues between units?",
      "Which parts or components tend to fail or wear out first?"
    ]
  },
  features_function: {
    id: 'features_function',
    name: '⚡ 功能卖点 / Features',
    nameShort: '功能卖点',
    icon: '⚡',
    description: '核心功能、差异化卖点、宣传与实际的差距',
    questions: [
      "What are the main features and selling points of this product?",
      "What can this product do that competing products cannot?",
      "Which advertised features actually work well in real use, and which disappoint?",
      "Does it have any smart, innovative, or standout capabilities?",
      "What accessories, parts, or extras are included in the box?"
    ]
  },
  ease_of_use: {
    id: 'ease_of_use',
    name: '🧭 易用上手 / Ease of Use',
    nameShort: '易用上手',
    icon: '🧭',
    description: '上手难度、学习曲线、清洁与维护',
    questions: [
      "How easy is this product to set up and start using?",
      "What do customers find confusing or frustrating when first using it?",
      "Is any assembly, app, subscription, or special skill required?",
      "How easy is it to clean, maintain, or store?",
      "How clear and helpful are the instructions or manual?"
    ]
  },
  fit_sizing: {
    id: 'fit_sizing',
    name: '📐 尺寸适配 / Fit, Size & Specs',
    nameShort: '尺寸适配',
    icon: '📐',
    description: '尺寸规格、是否符合描述、变体与兼容性',
    questions: [
      "What are the exact dimensions, weight, and capacity of this product?",
      "Do customers find the size, fit, or measurements accurate to the listing?",
      "What sizes, colors, or variants are available, and which are most popular?",
      "Is it compatible with the devices, spaces, or accessories customers expect?",
      "Is it compact and portable enough for travel or small spaces?"
    ]
  },
  comparison: {
    id: 'comparison',
    name: '⚔️ 竞品对比 / Competitive Comparison',
    nameShort: '竞品对比',
    icon: '⚔️',
    description: '与同类头部产品的优劣对比和迁移原因',
    questions: [
      "How does this product compare to the top-rated alternatives in its category?",
      "What are its main advantages over close competitors?",
      "Where do competing products clearly do better than this one?",
      "Is this the best option in its price range, and why or why not?",
      "What do customers who switched from another brand say about it?"
    ]
  },
  value_price: {
    id: 'value_price',
    name: '💰 性价比 / Value & Pricing',
    nameShort: '性价比',
    icon: '💰',
    description: '是否值这个价、定价感受、促销规律',
    questions: [
      "Do customers feel this product is worth the price?",
      "Are there cheaper alternatives offering similar quality?",
      "What is the typical price, and does it go on sale often?",
      "What do buyers feel they are overpaying or underpaying for?",
      "Is the long-term cost (refills, parts, upkeep) reasonable?"
    ]
  },
  target_audience: {
    id: 'target_audience',
    name: '🎯 适用人群 / Audience & Use Cases',
    nameShort: '适用人群',
    icon: '🎯',
    description: '最适合谁、最适合的场景、谁该避开',
    questions: [
      "Who is this product best suited for, and who should avoid it?",
      "What situations or use cases does it work best in?",
      "Is it suitable for beginners, professionals, gifting, or heavy daily use?",
      "What creative or unexpected uses have customers found for it?",
      "What level of experience or effort does it expect from the user?"
    ]
  },
  purchase_objections: {
    id: 'purchase_objections',
    name: '🤔 购买顾虑 / Objections',
    nameShort: '购买顾虑',
    icon: '🤔',
    description: '让人犹豫不下单的疑虑、误解与临门一脚',
    questions: [
      "What concerns or doubts make shoppers hesitate to buy this product?",
      "What misconceptions do customers have that turn out to be wrong?",
      "What risks or downsides should a buyer be aware of before purchasing?",
      "What would reassure a hesitant shopper and push them to buy?",
      "What objections do reviewers say they had that disappeared after using it?"
    ]
  },
  faq: {
    id: 'faq',
    name: '❓ 高频疑问 / FAQ',
    nameShort: '高频疑问',
    icon: '❓',
    description: '购买前最常被问、最想知道的实际问题',
    questions: [
      "What are the most frequently asked questions about this product?",
      "What practical details do buyers most want to know before purchasing?",
      "What do customers wish they had known before buying it?",
      "What questions come up repeatedly in the reviews and Q&A?",
      "What are the most common 'how do I...' questions for this product?"
    ]
  },
  after_sales: {
    id: 'after_sales',
    name: '🛡️ 售后保障 / After-Sales',
    nameShort: '售后保障',
    icon: '🛡️',
    description: '保修、客服响应、退换货体验',
    questions: [
      "What warranty or guarantee does this product come with?",
      "How responsive and helpful is the seller's customer service?",
      "What is the return and refund experience like for this product?",
      "Do customers report problems with warranty or replacement claims?",
      "How does the seller handle defective units or missing parts?"
    ]
  },
  logistics: {
    id: 'logistics',
    name: '📦 物流包装 / Shipping & Packaging',
    nameShort: '物流包装',
    icon: '📦',
    description: '包装保护、运输损坏、配送速度',
    questions: [
      "How is the packaging quality, and does it protect the product well?",
      "Do customers report shipping damage, missing parts, or leaks?",
      "How fast and reliable is the delivery for this product?",
      "Is the packaging easy to open and eco-friendly?",
      "Does the product arrive ready to use, or does it need extra setup?"
    ]
  },
  brand_trust: {
    id: 'brand_trust',
    name: '🏆 品牌信任 / Brand & Trust',
    nameShort: '品牌信任',
    icon: '🏆',
    description: '品牌口碑、信任度、产品线与定位',
    questions: [
      "What is this brand's reputation among customers?",
      "Do buyers trust this brand, and why or why not?",
      "What other popular products does this brand offer?",
      "Is the brand known more for quality, value, or innovation?",
      "How long has this brand been established in this category?"
    ]
  },
  improvement_ideas: {
    id: 'improvement_ideas',
    name: '💡 改进机会 / Improvement Gaps',
    nameShort: '改进机会',
    icon: '💡',
    description: '客户最想要的改进与未满足需求，给选品/迭代找方向',
    questions: [
      "What improvements do customers most often wish this product had?",
      "What unmet needs or gaps could a competing product exploit?",
      "What features would make customers choose this product over rivals?",
      "What small changes would turn 3-star reviews into 5-star reviews?",
      "What complaints appear across many similar products in this category?"
    ]
  }
};

// Export for use in different contexts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PRESET_QUESTIONS;
}
