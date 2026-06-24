/**
 * ASIN Parser Utility
 * Provides smart recognition and extraction of Amazon ASINs from various input formats.
 * 
 * Supports:
 * - Direct ASIN input (B0XXXXXXXXX)
 * - Comma-separated ASINs
 * - Newline-separated ASINs
 * - Space-separated ASINs
 * - Amazon URLs (extracts ASIN from URL)
 * - Mixed input (URLs + raw ASINs)
 * - Copy-paste from spreadsheets
 */

const AsinParser = {
  // ASIN pattern: starts with B0 followed by 8 alphanumeric characters
  ASIN_REGEX: /\b(B0[A-Z0-9]{8})\b/gi,
  
  // Amazon URL patterns that contain ASINs
  URL_ASIN_REGEX: /(?:\/dp\/|\/gp\/product\/|\/ASIN\/|\/product\/)([A-Z0-9]{10})/gi,

  /**
   * Marketplace domain mappings
   */
  MARKETPLACES: {
    'US': 'www.amazon.com',
    'UK': 'www.amazon.co.uk',
    'DE': 'www.amazon.de',
    'FR': 'www.amazon.fr',
    'IT': 'www.amazon.it',
    'ES': 'www.amazon.es',
    'JP': 'www.amazon.co.jp',
    'CA': 'www.amazon.ca',
    'AU': 'www.amazon.com.au',
    'IN': 'www.amazon.in',
    'MX': 'www.amazon.com.mx',
    'SG': 'www.amazon.sg',
    'BR': 'www.amazon.com.br',
    'NL': 'www.amazon.nl',
    'SA': 'www.amazon.sa',
    'AE': 'www.amazon.ae',
    'PL': 'www.amazon.pl',
    'SE': 'www.amazon.se',
    'BE': 'www.amazon.com.be',
    'EG': 'www.amazon.eg'
  },

  /**
   * Parse raw input text and extract unique ASINs
   * @param {string} input - Raw user input containing ASINs
   * @returns {string[]} Array of unique, validated ASINs
   */
  parse(input) {
    if (!input || typeof input !== 'string') return [];
    
    const asins = new Set();
    
    // First, try to extract ASINs from URLs
    let urlMatch;
    const urlRegex = new RegExp(this.URL_ASIN_REGEX.source, 'gi');
    while ((urlMatch = urlRegex.exec(input)) !== null) {
      const asin = urlMatch[1].toUpperCase();
      if (this.isValidAsin(asin)) {
        asins.add(asin);
      }
    }
    
    // Then extract standalone ASINs
    let asinMatch;
    const asinRegex = new RegExp(this.ASIN_REGEX.source, 'gi');
    while ((asinMatch = asinRegex.exec(input)) !== null) {
      const asin = asinMatch[1].toUpperCase();
      if (this.isValidAsin(asin)) {
        asins.add(asin);
      }
    }
    
    return Array.from(asins);
  },

  /**
   * Validate an ASIN format
   * @param {string} asin - ASIN to validate
   * @returns {boolean}
   */
  isValidAsin(asin) {
    return /^[A-Z0-9]{10}$/.test(asin);
  },

  /**
   * Build Amazon product URL from ASIN and marketplace
   * @param {string} asin - Product ASIN
   * @param {string} marketplace - Marketplace code (e.g., 'US', 'UK')
   * @returns {string} Full Amazon product URL
   */
  buildUrl(asin, marketplace = 'US') {
    const domain = this.MARKETPLACES[marketplace] || this.MARKETPLACES['US'];
    return `https://${domain}/dp/${asin}`;
  },

  /**
   * Detect marketplace from URL
   * @param {string} url - Amazon URL
   * @returns {string} Marketplace code
   */
  detectMarketplace(url) {
    for (const [code, domain] of Object.entries(this.MARKETPLACES)) {
      if (url.includes(domain)) {
        return code;
      }
    }
    return 'US';
  },

  /**
   * Format ASINs for display
   * @param {string[]} asins - Array of ASINs
   * @returns {string} Formatted string
   */
  formatForDisplay(asins) {
    return asins.join(', ');
  },

  /**
   * Get a summary of parsed input
   * @param {string} input - Raw input
   * @returns {object} Summary with count and ASINs
   */
  getSummary(input) {
    const asins = this.parse(input);
    return {
      count: asins.length,
      asins: asins,
      formatted: this.formatForDisplay(asins),
      isValid: asins.length > 0
    };
  }
};

// Export for use in different contexts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AsinParser;
}
