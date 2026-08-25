import React from 'react';
import { getSourceFlag } from '../constants/sourceMeta';

// Official brand icons via Google's favicon service — real logos for every
// source, no API key, no CDN dependency in the bundle. Falls back to the
// emoji flag if the favicon can't load.
const SOURCE_DOMAINS: Record<string, string> = {
  LinkedIn: 'linkedin.com',
  LinkedInPosts: 'linkedin.com',
  Indeed: 'indeed.com',
  Naukri: 'naukri.com',
  Glassdoor: 'glassdoor.com',
  Upwork: 'upwork.com',
  Greenhouse: 'greenhouse.io',
  Lever: 'lever.co',
  Ashby: 'ashbyhq.com',
  Workable: 'workable.com',
  Workday: 'workday.com',
  SmartRecruiters: 'smartrecruiters.com',
  Teamtailor: 'teamtailor.com',
  Personio: 'personio.com',
  BambooHR: 'bamboohr.com',
  Rippling: 'rippling.com',
  JazzHR: 'jazzhr.com',
  Recruitee: 'recruitee.com',
  iCIMS: 'icims.com',
  Comeet: 'comeet.com',
  Pinpoint: 'pinpoint.com',
  Join: 'join.com',
  Arbeitnow: 'arbeitnow.com',
  Dice: 'dice.com',
  Reed: 'reed.co.uk',
  RemoteOK: 'remoteok.com',
  WeWorkRemotely: 'weworkremotely.com',
  MyCareersFuture: 'mycareersfuture.gov.sg',
  Cutshort: 'cutshort.io',
  Gupy: 'gupy.io',
  JobsCh: 'jobs.ch',
  Daijob: 'daijob.com',
  MyJobMag: 'myjobmag.com',
};

export const SourceIcon: React.FC<{ source: string; size?: number; className?: string }> = ({ source, size = 14, className }) => {
  const [failed, setFailed] = React.useState(false);
  const domain = SOURCE_DOMAINS[source];
  if (!domain || failed) {
    return <span className={`text-[${size}px] leading-none ${className || ''}`}>{getSourceFlag(source)}</span>;
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`rounded-sm shrink-0 ${className || ''}`}
      style={{ width: size, height: size }}
    />
  );
};