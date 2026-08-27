import React, { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { ScraperBar } from './components/ScraperBar';
import { JobMatrix } from './components/JobMatrix';
import { JobDetailModal } from './components/JobDetailModal';
import { MasterCvScreen } from './components/MasterCvScreen';
import { SettingsModal } from './components/SettingsModal';
import { ManualJdScreen } from './components/ManualJdScreen';
import { JobPortalsScreen } from './components/JobPortalsScreen';
import { RecruitersScreen } from './components/RecruitersScreen';
import { AiSystemScreen } from './components/AiSystemScreen';
import { LinkedInPostsScreen } from './components/LinkedInPostsScreen';
import { OnboardingTour, startTour } from './components/OnboardingTour';
import { LoginScreen } from './components/LoginScreen';
import { Job, JobState, MasterCv, AppConfig, JobSource, TemplateId } from './types';
import { llmErrorMessage } from './lib/llmError';

// Dedicated URL routes — each screen has its own path so a reload (or a
// shared link) lands back on the SAME screen instead of the dashboard.
export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname } = location;
  // Screen visibility is URL-driven: the path decides which screen is open.
  // Reloading /recruiters → path is /recruiters → Recruiters screen opens.
  const isSettingsOpen = pathname === '/settings';
  const isRecruitersOpen = pathname === '/recruiters';
  const isMasterCvOpen = pathname === '/master-cv';
  const isManualJdOpen = pathname === '/manual-jd';
  const isJobPortalsOpen = pathname === '/job-portals';
  const isAiSystemOpen = pathname === '/ai-interview';
  const isLinkedInPostsOpen = pathname === '/linkedin-posts';

  // Unknown paths (stale bookmarks, typos) land on the dashboard instead of
  // a blank screen. Done BEFORE any screen renders.
  const knownPaths = ['/', '/settings', '/recruiters', '/master-cv', '/manual-jd', '/job-portals', '/ai-interview', '/linkedin-posts'];
  if (!knownPaths.includes(pathname)) return <Navigate to="/" replace />;

  const [jobs, setJobs] = useState<Job[]>([]);
  const [masterCv, setMasterCv] = useState<MasterCv | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [currentUser, setCurrentUser] = useState<{ id: string; email: string; name: string; isGuest: boolean } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Active filters and views
  const [activeStateTab, setActiveStateTab] = useState<'all' | JobState>('all');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedJobTab, setSelectedJobTab] = useState<'details' | 'gap' | 'tailored'>('details');

  // Drawers and Modals — visibility comes from the URL above; these hold
  // transient payloads only.
  const [recruiterBadge, setRecruiterBadge] = useState(0);
  const [recruiterFocus, setRecruiterFocus] = useState<{ name?: string | null; url?: string | null } | null>(null);

  // Loading states
  const [isScrapingLoading, setIsScrapingLoading] = useState(false);
  const [loadingJobIds, setLoadingJobIds] = useState<Set<string>>(new Set());
  const [scoreMessages, setScoreMessages] = useState<Record<string, string[]>>({});
  const [tailorMessages, setTailorMessages] = useState<Record<string, string[]>>({});

  // Server-side list state
  const [totalJobs, setTotalJobs] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; installed: string; repo: string } | null>(null);
  const [installedVersion, setInstalledVersion] = useState<string>('');
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [stats, setStats] = useState<{ total: number; pending: number; matched: number; tailored: number; applied: number; scoredCount: number; avgScore: number; byState: Record<string, number> }>({
    total: 0, pending: 0, matched: 0, tailored: 0, applied: 0, scoredCount: 0, avgScore: 0, byState: {},
  });
  const [searchTerm, setSearchTerm] = useState('');
  // Current search context returned by the last scrape. Scopes the follow-up
  // GET /api/jobs to exactly the jobs that search produced — NOT the toolbar
  // search box (which is a manual text filter, unrelated to scrape keywords).
  const [currentSearchId, setCurrentSearchId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<'all' | JobSource>('all');
  const [sortBy, setSortBy] = useState<'createdAt' | 'postedDate' | 'matchScore' | 'salaryMax'>('createdAt');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Per-job loading tracking. The list refresh is NEVER globally blocked —
  // pagination, filters, delete, and downloads stay live while any
  // match/tailor runs in the background.
  const addLoadingJobId = (id: string) => setLoadingJobIds((prev) => new Set(prev).add(id));
  const removeLoadingJobId = (id: string) => setLoadingJobIds((prev) => { const next = new Set(prev); next.delete(id); return next; });

  const runWithMessages = async (
    jobId: string,
    messages: string[],
    fn: () => Promise<void>,
    setter: React.Dispatch<React.SetStateAction<Record<string, string[]>>>,
  ) => {
    addLoadingJobId(jobId);
    let idx = 0;
    setter((prev) => ({ ...prev, [jobId]: [messages[0]] }));
    const timer = setInterval(() => {
      idx++;
      if (idx < messages.length) {
        setter((prev) => ({
          ...prev,
          [jobId]: [...(prev[jobId] || []), messages[idx]],
        }));
      }
    }, 1200);

    try {
      await fn();
    } catch (err) {
      console.error('Operation error:', err);
    } finally {
      clearInterval(timer);
      setter((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
      removeLoadingJobId(jobId);
      fetchJobs();
    }
  };

  // Fetch job list (server-side filtered + paginated) and stats.
  // Never blocked — runs on every page/filter change regardless of
  // background match/tailor operations.
  const fetchJobs = useCallback(async () => {
    const params = new URLSearchParams({
      state: activeStateTab,
      source: sourceFilter,
      search: searchTerm,
      sortBy,
      sortOrder: 'desc',
      page: String(page),
      limit: String(pageSize),
    });
    // Scope to the current search context ONLY on the all-jobs view. State
    // tabs (Applied/Tailored/Ready/Pending) stay global — history must not be
    // hidden by an unrelated later search.
    if (currentSearchId && activeStateTab === 'all') params.set('searchId', currentSearchId);
    const [listRes, statsRes] = await Promise.all([
      fetch(`/api/jobs?${params}`),
      fetch('/api/jobs/stats'),
    ]);
    if (listRes.ok) {
      const data = await listRes.json();
      setJobs(data.jobs || []);
      setTotalJobs(data.total || 0);
    }
    if (statsRes.ok) {
      setStats(await statsRes.json());
    }
  }, [activeStateTab, sourceFilter, searchTerm, sortBy, page, pageSize, currentSearchId]);

  // Back/Close from any screen: land on the dashboard with FRESH data from
  // the server (newly saved LinkedIn posts, scraped jobs, updated scores)
  // and the newest page — never a stale in-memory view.
  const goHome = useCallback(() => {
    navigate('/');
    if (currentUser) {
      if (page !== 1) setPage(1); // triggers the filters effect → refetch
      else fetchJobs();           // already page 1 — fetch now
    }
  }, [navigate, currentUser, page, fetchJobs]);

  // Initial Fetch (session + config + first page)
  const fetchAllData = async () => {
    try {
      const [authRes, configRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/config'),
      ]);

      if (authRes.ok) {
        const authData = await authRes.json();
        setCurrentUser(authData.user);
        if (authData.user) {
          const cvRes = await fetch('/api/cv/master');
          if (cvRes.ok) {
            const cvData = await cvRes.json();
            setMasterCv(cvData);
          }
          await fetchJobs();
        }
      }
      if (configRes.ok) {
        const configData = await configRes.json();
        setConfig(configData);
      }
    } catch (err) {
      console.error('Failed to fetch initial data:', err);
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    fetchAllData();
  }, []);

  // One-click auto-update: the server pulls latest main and restarts itself.
  // We poll /api/update-check while it's down and reload the moment it's back.
  const handleUpdateNow = async () => {
    setUpdating(true);
    setUpdateError(null);
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error || 'Update failed.');
      setUpdateMsg('Updating… the app will restart automatically.');
      setTimeout(() => window.location.reload(), 60000);
      const t = setInterval(() => {
        fetch('/api/update-check')
          .then((r) => {
            if (r.ok) { clearInterval(t); window.location.reload(); }
          })
          .catch(() => {});
      }, 5000);
    } catch (err: any) {
      setUpdating(false);
      setUpdateError(err?.message || 'Could not reach the update service.');
    }
  };

  // Check GitHub on app open AND every 30 minutes while the app is open: if
  // a newer version was pushed, the banner appears — dismissible per version.
  useEffect(() => {
    const checkForUpdates = () => {
      fetch('/api/update-check')
        .then((r) => r.json())
        .then((d) => {
          if (d?.installed) setInstalledVersion(d.installed);
          if (!d?.updateAvailable) return;
          setUpdateInfo({ latest: d.latest, installed: d.installed, repo: d.repo });
          setUpdateDismissed(localStorage.getItem('ats.updateDismissed') === d.latest);
        })
        .catch(() => {});
    };
    checkForUpdates();
    const t = setInterval(checkForUpdates, 30 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Refetch whenever filters/pagination change
  useEffect(() => {
    if (currentUser) fetchJobs();
  }, [fetchJobs, currentUser]);

  // Reset to page 1 when a filter changes
  useEffect(() => {
    setPage(1);
  }, [activeStateTab, sourceFilter, searchTerm, sortBy, pageSize]);

  // Scrape Handler
  const handleScrape = async (params: {
    keywords: string;
    location: string;
    sources: JobSource[];
    datePostedFilter: 'all' | '24h' | '7d' | '30d';
    jobType?: 'all' | 'remote' | 'onsite' | 'hybrid';
    minSalary?: number;
    maxJobsPerSource?: number;
    contractType?: string;
    experienceLevel?: string;
    under10Applicants?: boolean;
  }) => {
    setIsScrapingLoading(true);
    try {
      // V2 unified search behind a feature flag: when enabled, ScraperBar
      // submissions route to the provider-driven search endpoint (cache-first,
      // FetchCat ATS + board providers). When disabled, V1 stays untouched.
      const v2Enabled = (import.meta.env.VITE_V2_SEARCH_ENABLED ?? 'false') !== 'false';
      const endpoint = v2Enabled ? '/api/jobs/search-v2' : '/api/jobs/scrape';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (res.ok) {
        const data = await res.json();
        // Searching ADDS jobs to the store. The list now scopes to the current
        // search context (searchId) so a later, unrelated search does not mix
        // its results in. Use the toolbar search box / source / sort controls
        // to filter the view manually.
        if (data.searchId) setCurrentSearchId(data.searchId);
        setActiveStateTab('all');
        setPage(1);
        await fetchJobs();
        // Notification badge: new recruiters found in this scrape's
        // descriptions (accumulates until the Recruiters screen is opened).
        if (data.newContacts?.length > 0) {
          setRecruiterBadge((prev) => prev + data.newContacts.length);
        }
        // V2 search returns cached candidates (searchId/returnedCount/jobs),
        // not durable additions — the banner reports matches found.
        if (data.queryFp !== undefined) {
          return {
            scrapedTotal: data.returnedCount || 0,
            addedCount: data.returnedCount || 0,
            skippedDuplicates: 0,
            filteredOutCount: 0,
            skippedSources: [],
            newContacts: [],
            isV2: true,
            cacheHit: data.cacheHit === true,
          };
        }
        return { scrapedTotal: data.scrapedTotal || 0, addedCount: data.addedCount || 0, skippedDuplicates: data.skippedDuplicates || 0, filteredOutCount: data.filteredOutCount || 0, skippedSources: data.skippedSources || [], newContacts: data.newContacts || [] };
      } else {
        const err = await res.json();
        alert(`Scrape error: ${err.error}`);
        return { scrapedTotal: 0, addedCount: 0, skippedDuplicates: 0 };
      }
    } catch (err: any) {
      alert(`Scrape request failed: ${err.message}`);
      return { scrapedTotal: 0, addedCount: 0, skippedDuplicates: 0 };
    } finally {
      setIsScrapingLoading(false);
    }
  };

  // Match Job Handler
  const handleMatchJob = async (jobId: string) => {
    runWithMessages(jobId, [
      'Reading job requirements from LinkedIn...',
      'Extracting hard skills & technologies...',
      'Comparing against your Master CV...',
      'Identifying matching & missing keywords...',
      'Computing weighted ATS match score...',
    ], async () => {
      const res = await fetch(`/api/jobs/${jobId}/match`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setJobs((prev) => prev.map((j) => (j.id === jobId ? data.job : j)));
        if (selectedJob && selectedJob.id === jobId) setSelectedJob(data.job);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(llmErrorMessage(data.code, data.error));
        throw new Error(data.error || 'Match failed');
      }
    }, setScoreMessages);
  };

  // Batch Match Handler
  // Tailor CV Handler
  const handleTailorJob = async (jobId: string) => {
    runWithMessages(jobId, [
      'Analyzing job requirements from description...',
      'Matching skills with your Master CV profile...',
      'Rewriting experience bullets with JD keywords...',
      'Integrating missing keywords into sections...',
      'Verifying all keywords are placed correctly...',
      'Generating ATS-ready PDF document...',
    ], async () => {
      const res = await fetch(`/api/jobs/${jobId}/tailor`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setJobs((prev) => prev.map((j) => (j.id === jobId ? data.job : j)));
        if (selectedJob && selectedJob.id === jobId) setSelectedJob(data.job);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(llmErrorMessage(data.code, data.error));
        throw new Error(data.error || 'Tailor failed');
      }
    }, setTailorMessages);
  };

  // Status Update Handler
  const handleUpdateStatus = async (jobId: string, state: JobState) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      });

      if (res.ok) {
        const data = await res.json();
        setJobs((prev) => prev.map((j) => (j.id === jobId ? data.job : j)));
        fetchJobs();
      }
    } catch (err) {
      console.error('Status update error:', err);
    }
  };

  // Delete Job Handler
  const handleDeleteJob = async (jobId: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        if (selectedJob && selectedJob.id === jobId) {
          setSelectedJob(null);
        }
        fetchJobs();
      }
    } catch (err) {
      console.error('Delete error:', err);
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Clear all jobs? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/jobs', { method: 'DELETE' });
      if (res.ok) {
        setJobs([]);
        setSelectedJob(null);
        fetchJobs();
      }
    } catch (err) {
      console.error('Clear all error:', err);
    }
  };

  // Save Master CV Handler — returns true on success so the editor can show
  // an honest "Saved!" vs an error (never a fake success on a failed request).
  const handleSaveMasterCv = async (updatedCv: MasterCv): Promise<boolean> => {
    try {
      const res = await fetch('/api/cv/master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedCv),
      });

      if (res.ok) {
        const data = await res.json();
        setMasterCv(data.cv);
        return true;
      }
      console.error('Save master CV failed:', res.status);
      return false;
    } catch (err) {
      console.error('Save master CV error:', err);
      return false;
    }
  };

  // ── Auth handlers ──
  const handleLogin = async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Login failed.' };
    setCurrentUser(data.user);
    setMasterCv(null);
    await fetchAllData();
    return null;
  };

  const handleRegister = async (name: string, email: string, password: string, recovery?: { q1: string; a1: string; q2: string; a2: string }) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        password,
        recoveryQ1: recovery?.q1,
        recoveryA1: recovery?.a1,
        recoveryQ2: recovery?.q2,
        recoveryA2: recovery?.a2,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Registration failed.' };
    setCurrentUser(data.user);
    setMasterCv(null);
    await fetchAllData();
    return null;
  };

  const handleGuestLogin = async (name: string) => {
    const res = await fetch('/api/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Guest login failed.' };
    setCurrentUser(data.user);
    setMasterCv(null);
    await fetchAllData();
    return null;
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setCurrentUser(null);
    setMasterCv(null);
    setJobs([]);
    setSelectedJob(null);
    navigate('/');
  };

  // Save Config Handler
  const handleSaveConfig = async (updatedConfig: AppConfig) => {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedConfig),
      });

      if (res.ok) {
        const data = await res.json();
        setConfig(data.config);
      }
    } catch (err) {
      console.error('Save config error:', err);
    }
  };
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans antialiased selection:bg-blue-600 selection:text-white">
      <OnboardingTour ready={!!currentUser && !authLoading} />
      {authLoading ? (
        <div className="min-h-screen flex items-center justify-center text-slate-500">Loading…</div>
      ) : !currentUser ? (
        <LoginScreen
          onLogin={handleLogin}
          onRegister={handleRegister}
          onGuestLogin={handleGuestLogin}
        />
      ) : (
        <>
          <style>{`
            .update-banner{display:flex; align-items:center; gap:12px; padding:8px 16px; background:#052E16; color:#D1FAE5;
              font-size:13px; font-weight:600; flex-wrap:wrap;}
            .update-banner b{color:#6EE7B7;}
            .update-banner a{color:#34D399; font-weight:800; text-decoration:underline; text-underline-offset:2px;}
            .update-banner .update-cta{background:#059669; color:#fff; border:none; font-weight:800; font-size:12px;
              padding:5px 14px; border-radius:8px; cursor:pointer;}
            .update-banner .update-cta:hover{background:#047857;}
            .update-banner .update-cta:disabled{opacity:.6; cursor:wait;}
            .update-banner .update-msg{color:#A7F3D0; font-size:12.5px;}
            .update-banner .update-err{color:#FCA5A5; font-size:12.5px;}
            .update-banner button{margin-left:auto; background:none; border:none; color:#A7F3D0; font-size:13px; font-weight:800;
              cursor:pointer; padding:2px 8px; border-radius:6px;}
            .update-banner button:hover{background:#064E3B; color:#fff;}
            .update-banner .update-cta{margin-left:0;}
          `}</style>
          {/* Header Navigation */}
          <Navbar
            user={currentUser}
            onLogout={handleLogout}
            onOpenMasterCv={() => navigate('/master-cv')}
            onOpenSettings={() => navigate('/settings')}
            onOpenManualJd={() => navigate('/manual-jd')}
            onOpenJobPortals={() => navigate('/job-portals')}
            onOpenRecruiters={() => {
              setRecruiterBadge(0);
              navigate('/recruiters');
            }}
            onOpenChat={() => navigate('/ai-interview')}
            onOpenLinkedInPosts={() => navigate('/linkedin-posts')}
            recruiterBadge={recruiterBadge}
            installedVersion={installedVersion}
            onTour={startTour}
          />

          {/* Update banner — a newer version was pushed to GitHub */}
          {updateInfo && !updateDismissed && (
            <div className="update-banner">
              <span>
                New version <b>v{updateInfo.latest}</b> is available — you're on v{updateInfo.installed}.
              </span>
              {updateMsg ? (
                <span className="update-msg">{updateMsg}</span>
              ) : (
                <button className="update-cta" onClick={handleUpdateNow} disabled={updating}>
                  {updating ? 'Updating…' : 'Update & Restart'}
                </button>
              )}
              {updateError && <span className="update-err">{updateError}</span>}
              <a href={updateInfo.repo} target="_blank" rel="noreferrer">View on GitHub</a>
              <button
                className="update-x"
                onClick={() => { setUpdateDismissed(true); localStorage.setItem('ats.updateDismissed', updateInfo.latest); }}
                title="Hide this update notice (v{latest} stays hidden until the next version)"
              >✕</button>
            </div>
          )}

          {/* Live Job Search Bar */}
          <ScraperBar
            onScrape={handleScrape}
            isLoading={isScrapingLoading}
            apifyAvailable={!!config?.apify.enabled && !!config?.apify.token}
          />

          {/* Main Jobs Matrix View */}
          <main>
            <JobMatrix
              jobs={jobs}
              totalJobs={totalJobs}
              stats={stats}
              activeStateTab={activeStateTab}
              onStateTabChange={setActiveStateTab}
              searchTerm={searchTerm}
              setSearchTerm={setSearchTerm}
              sourceFilter={sourceFilter}
              setSourceFilter={setSourceFilter}
              sortBy={sortBy}
              setSortBy={setSortBy}
              page={page}
              setPage={setPage}
              pageSize={pageSize}
              setPageSize={setPageSize}
              onSelectJob={(job) => { setSelectedJob(job); setSelectedJobTab('details'); }}
            onOpenRecruiter={(job) => { setRecruiterFocus({ name: job.recruiterName, url: job.recruiterUrl }); navigate('/recruiters'); }}
              onSelectTailoredReview={(job) => { setSelectedJob(job); setSelectedJobTab('tailored'); }}
              onMatchJob={handleMatchJob}
              onTailorJob={handleTailorJob}
              onDeleteJob={handleDeleteJob}
              onUpdateStatus={handleUpdateStatus}
              onClearAll={handleClearAll}
              loadingJobIds={loadingJobIds}
              scoreMessages={scoreMessages}
              tailorMessages={tailorMessages}
            />
          </main>

          {/* Job Details & Tailored CV Modal */}
          <JobDetailModal
            job={selectedJob}
            onClose={() => setSelectedJob(null)}
            onMatchJob={handleMatchJob}
            onTailorJob={handleTailorJob}
            onUpdateStatus={handleUpdateStatus}
            isLoading={selectedJob ? loadingJobIds.has(selectedJob.id) : false}
            initialTab={selectedJobTab}
            cvTemplate={(masterCv?.templateId || 'harvard') as TemplateId}
            masterCv={masterCv}
          />

          {/* Master Candidate CV — full screen (always mounted, URL-driven) */}
          {masterCv && (
            <MasterCvScreen
              isOpen={isMasterCvOpen}
              onClose={goHome}
              masterCv={masterCv}
              onSaveMasterCv={handleSaveMasterCv}
            />
          )}

          {/* System INI Config Settings Modal */}
          {config && (
            <SettingsModal
              isOpen={isSettingsOpen}
              onClose={goHome}
              config={config}
              onSaveConfig={handleSaveConfig}
              user={currentUser}
              onOpenMasterCv={() => navigate('/master-cv')}
            />
          )}

          {/* Manual JD — full screen */}
          <ManualJdScreen
            isOpen={isManualJdOpen}
            onClose={goHome}
            masterCv={masterCv}
          />

          {/* Job Portals Directory — full screen */}
          <JobPortalsScreen
            isOpen={isJobPortalsOpen}
            onClose={goHome}
          />

          {/* Recruiters — emails found in job descriptions */}
          <RecruitersScreen
            isOpen={isRecruitersOpen}
            onClose={goHome}
            focusRecruiter={recruiterFocus}
          />

          {/* AI Interview */}
          {isAiSystemOpen && <AiSystemScreen onClose={goHome} />}
          {isLinkedInPostsOpen && <LinkedInPostsScreen onClose={goHome} />}
        </>
      )}
    </div>
  );
}
