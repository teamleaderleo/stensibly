/**
 * Stensibly Tactical Studio Radar Scope (ATC Console)
 *
 * Visualizes active agent workers as tactical aircraft on a radar sweep.
 * Features rotating sweep beam, range rings, aircraft data tags, conflict alerts,
 * and 1-tap flight strip interaction.
 */

export function createStudioRadar({ canvas, container, onSelectFlight }) {
  if (!canvas) return { update: () => {}, destroy: () => {} };

  const ctx = canvas.getContext('2d');
  let animationFrameId;
  let sweepAngle = 0;
  let flights = [];
  let selectedFlightId = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
  }

  window.addEventListener('resize', resize);
  resize();

  canvas.addEventListener('click', handleCanvasClick);
  canvas.addEventListener('touchstart', handleCanvasTouch, { passive: true });

  function handleCanvasClick(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    checkHit(x, y);
  }

  function handleCanvasTouch(event) {
    if (!event.touches.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.touches[0].clientX - rect.left;
    const y = event.touches[0].clientY - rect.top;
    checkHit(x, y);
  }

  function checkHit(clickX, clickY) {
    const width = canvas.getBoundingClientRect().width;
    const height = canvas.getBoundingClientRect().height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.42;

    let hit = null;
    for (const flight of flights) {
      const fx = cx + Math.cos(flight.angle) * (flight.distance * radius);
      const fy = cy + Math.sin(flight.angle) * (flight.distance * radius);
      const dist = Math.hypot(clickX - fx, clickY - fy);
      if (dist < 28) {
        hit = flight;
        break;
      }
    }

    selectedFlightId = hit ? hit.id : null;
    if (hit && typeof onSelectFlight === 'function') {
      onSelectFlight(hit);
    }
  }

  function updateItems(items) {
    const valid = items.filter((item) => item.status !== 'archived');
    flights = valid.map((item, index) => {
      const seed = hashString(item.id || item.title);
      const angle = ((seed % 360) * Math.PI) / 180 + (index * 0.4);
      const distance = 0.25 + ((seed % 65) / 100);
      const callsign = item.claimedBy
        ? item.claimedBy.toUpperCase()
        : `AGENT-${item.id.slice(0, 4).toUpperCase()}`;

      return {
        id: item.id,
        callsign,
        title: item.title,
        status: item.status,
        project: item.project,
        priority: item.priority || 50,
        nextAction: item.nextAction || '',
        angle,
        distance,
        heading: angle + Math.PI / 2,
      };
    });
  }

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.44;

    ctx.clearRect(0, 0, width, height);

    // 1. Tactical Radar Background & Range Rings
    ctx.fillStyle = '#060a08';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#123320';
    ctx.lineWidth = 1;

    // Outer boundary & Range rings
    for (const step of [0.33, 0.66, 1.0]) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * step, 0, Math.PI * 2);
      ctx.stroke();

      // Range text
      ctx.fillStyle = '#1c4d32';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillText(`${Math.round(step * 15)}NM`, cx + 4, cy - (radius * step) + 12);
    }

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // 2. Rotating Radar Sweep Beam (Flat segment approximation - no gradient)
    sweepAngle = (sweepAngle + 0.02) % (Math.PI * 2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, sweepAngle, sweepAngle + 0.08);
    ctx.closePath();
    ctx.fillStyle = 'rgba(34, 197, 94, 0.15)';
    ctx.fill();

    // Leading sweep line
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweepAngle + 0.08) * radius, cy + Math.sin(sweepAngle + 0.08) * radius);
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // 3. Center Hub (Studio Station)
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#86efac';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('STUDIO TWR', cx, cy + 16);

    // 4. Conflict detection lines (Amber dashed line between concurrent active items)
    const activeFlights = flights.filter((f) => f.status === 'active');
    if (activeFlights.length >= 2) {
      for (let i = 0; i < activeFlights.length; i++) {
        for (let j = i + 1; j < activeFlights.length; j++) {
          const f1 = activeFlights[i];
          const f2 = activeFlights[j];
          const x1 = cx + Math.cos(f1.angle) * (f1.distance * radius);
          const y1 = cy + Math.sin(f1.angle) * (f1.distance * radius);
          const x2 = cx + Math.cos(f2.angle) * (f2.distance * radius);
          const y2 = cy + Math.sin(f2.angle) * (f2.distance * radius);

          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = '#eab308';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 5. Draw Aircraft Blips & Flight Tags
    for (const flight of flights) {
      const fx = cx + Math.cos(flight.angle) * (flight.distance * radius);
      const fy = cy + Math.sin(flight.angle) * (flight.distance * radius);
      const isSelected = flight.id === selectedFlightId;

      // Status colors
      const color = flight.status === 'active'
        ? '#22c55e'
        : flight.status === 'blocked'
          ? '#ef4444'
          : '#38bdf8';

      // Blip symbol
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(fx, fy, isSelected ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Heading vector
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx + Math.cos(flight.heading) * 14, fy + Math.sin(flight.heading) * 14);
      ctx.stroke();

      // Selection reticle
      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(fx - 8, fy - 8, 16, 16);
      }

      // Tactical Flight Data Block
      ctx.fillStyle = color;
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(flight.callsign, fx + 8, fy - 6);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillText(`FL${flight.priority} · ${flight.status.toUpperCase()}`, fx + 8, fy + 4);
      ctx.fillText(flight.title.slice(0, 18) + (flight.title.length > 18 ? '…' : ''), fx + 8, fy + 14);
    }

    animationFrameId = requestAnimationFrame(draw);
  }

  draw();

  return {
    update(items) {
      updateItems(items);
    },
    destroy() {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
    },
  };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
