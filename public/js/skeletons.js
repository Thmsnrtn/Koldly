/**
 * Skeleton Loading Components
 * Reusable skeleton screens for loading states
 */

const Skeletons = {
  /**
   * Campaign card skeleton
   */
  campaignCard: `
    <div style="
      background: var(--bg-card);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
      border: 1px solid var(--border);
      animation: pulse 1.5s ease-in-out infinite;
    ">
      <div style="
        background: rgba(255, 255, 255, 0.1);
        height: 20px;
        border-radius: 4px;
        margin-bottom: 12px;
        width: 60%;
      "></div>
      <div style="
        background: rgba(255, 255, 255, 0.05);
        height: 12px;
        border-radius: 4px;
        margin-bottom: 8px;
        width: 40%;
      "></div>
      <div style="
        background: rgba(255, 255, 255, 0.05);
        height: 12px;
        border-radius: 4px;
        width: 50%;
      "></div>
    </div>
  `,

  /**
   * Stats card skeleton
   */
  statCard: `
    <div style="
      background: var(--bg-card);
      border-radius: 12px;
      padding: 20px;
      border: 1px solid var(--border);
      animation: pulse 1.5s ease-in-out infinite;
    ">
      <div style="
        background: rgba(255, 255, 255, 0.05);
        height: 12px;
        border-radius: 4px;
        margin-bottom: 12px;
        width: 70%;
      "></div>
      <div style="
        background: rgba(255, 255, 255, 0.15);
        height: 28px;
        border-radius: 4px;
      "></div>
    </div>
  `,

  /**
   * Table row skeleton
   */
  tableRow: `
    <tr style="border-bottom: 1px solid var(--border);">
      <td style="padding: 16px;">
        <div style="
          background: rgba(255, 255, 255, 0.1);
          height: 12px;
          border-radius: 4px;
          width: 40%;
          animation: pulse 1.5s ease-in-out infinite;
        "></div>
      </td>
      <td style="padding: 16px;">
        <div style="
          background: rgba(255, 255, 255, 0.1);
          height: 12px;
          border-radius: 4px;
          width: 50%;
          animation: pulse 1.5s ease-in-out infinite;
        "></div>
      </td>
      <td style="padding: 16px;">
        <div style="
          background: rgba(255, 255, 255, 0.1);
          height: 12px;
          border-radius: 4px;
          width: 30%;
          animation: pulse 1.5s ease-in-out infinite;
        "></div>
      </td>
    </tr>
  `,

  /**
   * Chart skeleton
   */
  chart: `
    <div style="
      background: var(--bg-card);
      border-radius: 8px;
      padding: 20px;
      border: 1px solid var(--border);
      min-height: 300px;
      animation: pulse 1.5s ease-in-out infinite;
    ">
      <div style="
        background: rgba(255, 255, 255, 0.1);
        height: 16px;
        border-radius: 4px;
        margin-bottom: 20px;
        width: 50%;
      "></div>
      <div style="display: flex; gap: 12px; height: 200px; align-items: flex-end;">
        ${Array(5).fill(0).map(() => `
          <div style="
            background: rgba(255, 107, 53, 0.3);
            flex: 1;
            border-radius: 4px;
            height: ${Math.random() * 80 + 20}%;
          "></div>
        `).join('')}
      </div>
    </div>
  `,

  /**
   * Form skeleton
   */
  form: `
    <div style="animation: pulse 1.5s ease-in-out infinite;">
      <div style="
        background: rgba(255, 255, 255, 0.1);
        height: 12px;
        border-radius: 4px;
        margin-bottom: 8px;
        width: 30%;
      "></div>
      <div style="
        background: rgba(255, 255, 255, 0.05);
        height: 40px;
        border-radius: 6px;
        margin-bottom: 20px;
      "></div>
      <div style="
        background: rgba(255, 255, 255, 0.1);
        height: 12px;
        border-radius: 4px;
        margin-bottom: 8px;
        width: 30%;
      "></div>
      <div style="
        background: rgba(255, 255, 255, 0.05);
        height: 40px;
        border-radius: 6px;
        margin-bottom: 20px;
      "></div>
      <div style="
        background: rgba(255, 255, 255, 0.05);
        height: 40px;
        border-radius: 6px;
      "></div>
    </div>
  `
};

// Add pulse animation to document
if (!document.getElementById('skeleton-styles')) {
  const style = document.createElement('style');
  style.id = 'skeleton-styles';
  style.textContent = `
    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }
  `;
  document.head.appendChild(style);
}
