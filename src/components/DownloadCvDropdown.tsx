import React from 'react';
import { Download, FileCode } from 'lucide-react';

interface DownloadCvDropdownProps {
  jobId: string;
  size?: 'sm' | 'md';
  buttonText?: string;
  className?: string;
}

export const DownloadCvDropdown: React.FC<DownloadCvDropdownProps> = ({
  jobId,
  size = 'sm',
  buttonText = 'Download CV',
  className = '',
}) => {
  const isSmall = size === 'sm';

  const handleDownload = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const a = document.createElement('a');
    a.href = `/api/jobs/${jobId}/download-pdf`;
    a.download = '';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      className={`inline-flex items-center space-x-1.5 rounded-md font-semibold bg-slate-900 hover:bg-slate-800 text-white transition-all shadow-xs cursor-pointer ${
        isSmall ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-xs'
      } ${className}`}
      title="Download tailored resume as PDF"
    >
      <FileCode className={isSmall ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
      <span>{buttonText}</span>
      <Download className={isSmall ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
    </button>
  );
};
