/**
 * Headless Pipeline Test — exercises the full Conductor pipeline
 * with the Vite + GSAP + React furniture website intent.
 * Run: npx ts-node src/test-pipeline.ts
 */
import { Conductor } from './core/conductor';
import * as path from 'path';
import * as fs from 'fs';

const PROJECT_NAME = 'furniture-luxury';
const INTENT = `Build a luxury curated furniture brand website using Vite + React + GSAP + Lenis scroll.

Core requirements:
1. Vite + React project setup with no React state for animations (only local variables, direct DOM refs, isolated animation controllers)
2. GSAP for all animations — smooth scrub animations tied to Lenis smooth scroll
3. Lenis for smooth scrolling with GSAP ScrollTrigger integration
4. Optionally add Three.js for 3D product showcase
5. Luxury motion design: slow reveals, parallax depth, staggered fade-ups, scale transitions
6. Every animation must have cleanup on unmount (use gsap.context or manual kill())
7. Pages: Hero with parallax product hero, Curated Collection grid with stagger reveal, Product detail with 3D viewer, About with timeline scroll, Contact with form animation
8. Dark luxury theme: deep charcoal (#0A0A0A), gold accents (#C9A96E), cream text (#F5F0E8), serif headings (Playfair Display), sans-serif body (Inter)
9. Responsive: mobile-first, 320px-2560px
10. Accessibility: keyboard nav, reduced motion support, semantic HTML

Tech stack decisions: Vite, React 18, GSAP 3, Lenis (smooth scroll), no state for animations, direct DOM refs via useRef, all animations isolated and cleaned up on destroy.`;

const BASE_DIR = path.join(__dirname, '..');
const workspaceDir = path.join(BASE_DIR, 'projects', PROJECT_NAME, 'workspace');

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  TRIAD ENGINE — Pipeline Test');
  console.log('  Project: furniture-luxury');
  console.log('  Intent: Vite + React + GSAP + Lenis');
  console.log('═══════════════════════════════════════════\n');

  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    console.log(`Created workspace: ${workspaceDir}`);
  }

  const conductor = new Conductor(PROJECT_NAME, workspaceDir);

  conductor.setBroadcast((event: string, data: any) => {
    const ts = new Date().toISOString().slice(11, 19);

    if (event === 'log') {
      const msg = data.message || JSON.stringify(data);
      // Truncate very long messages
      const display = msg.length > 200 ? msg.slice(0, 200) + '...' : msg;
      const role = data.role ? `[${data.role.toUpperCase()}]` : '';
      console.log(`[${ts}] ${role} ${display}`);
    } else if (event === 'state_update') {
      const s = data.status || '?';
      const role = data.current_agent_role ? ` (${data.current_agent_role})` : '';
      console.log(`[${ts}] STATE: ${s}${role} | Tasks: ${data.task_queue?.length || 0} | Loop: ${data.loop_count || 0}`);
    } else if (event === 'plan_ready') {
      console.log(`\n═════════ PLAN READY ═════════`);
      console.log(`[${ts}] ${data.tasks?.length || 0} tasks generated`);
      if (data.tasks) {
        data.tasks.slice(0, 10).forEach((t: any) => {
          console.log(`  • ${t.id}: ${t.description?.substring(0, 80)}`);
        });
        if (data.tasks.length > 10) console.log(`  ... and ${data.tasks.length - 10} more`);
      }
      console.log(`═══════════════════════════════\n`);
    } else if (event === 'project_complete') {
      console.log(`\n═════════ PROJECT COMPLETE ═════════`);
      console.log(`  Tasks: ${data.taskCount} | Completed: ${data.completedCount || data.taskCount}`);
      console.log(`  Loops: ${data.loopCount} | Intent satisfied: ${data.intentSatisfied}`);
      console.log(`  Failed: ${data.failed ? 'YES' : 'NO'}`);
      console.log(`═══════════════════════════════════\n`);
    } else if (event === 'progress_report') {
      console.log(`\n═════════ PROGRESS REPORT ═════════`);
      console.log(data.summary?.substring(0, 500) || JSON.stringify(data).substring(0, 500));
      console.log(`═══════════════════════════════════\n`);
    } else if (event === 'error') {
      console.log(`[${ts}] ERROR: ${data.message}`);
    } else if (event === 'ui_test_result') {
      console.log(`[${ts}] UI TEST: ${data.passed ? 'PASS' : 'FAIL'} (${data.passedSteps}/${data.totalSteps})`);
    } else if (event === 'cost_update') {
      console.log(`[${ts}] COST: $${data.total?.toFixed(4) || '0'} (${data.percentUsed}%)`);
    }
  });

  console.log('Starting conductor...\n');
  try {
    await conductor.start(INTENT);
    console.log('\nConductor pipeline launched. Waiting for completion...\n');
  } catch (e: any) {
    console.error('FATAL:', e.message);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Unhandled:', e);
  process.exit(1);
});
