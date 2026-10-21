import React from 'react';

/**
 * The ONE brand mark — byte-for-byte the SVG used on the marketing site
 * (tailor-ai.in). Do not restyle locally; change it in both places together.
 */
export const BrandMark: React.FC<{ size?: number; className?: string; title?: string }> = ({
  size = 36,
  className,
  title = 'Tailor AI',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 64 64"
    width={size}
    height={size}
    className={className}
    role="img"
    aria-label={title}
  >
    <rect x="2" y="2" width="60" height="60" rx="12" fill="#0098F2" />
    <text x="32" y="45" fontFamily="Geist, Helvetica, Arial, sans-serif" fontSize="34" fontWeight="700" fill="#FFFFFF" textAnchor="middle">T</text>
  </svg>
);
