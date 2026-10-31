import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Layers, ChevronRight } from 'lucide-react';
import { http } from '../../lib/api';

export default function TnaTemplatesPage() {
  const nav = useNavigate();
  const [selectedTplId, setSelectedTplId] = useState<number>(1);

  const templatesQuery = useQuery({
    queryKey: ['tna-templates-full'],
    queryFn: async () => (await http.get<{ data: any[] }>('/tna/templates')).data,
  });

  const templateDetailQuery = useQuery({
    queryKey: ['tna-template-detail', selectedTplId],
    queryFn: async () => (await http.get<{ data: any }>(`/tna/templates/${selectedTplId}`)).data,
    enabled: Boolean(selectedTplId),
  });

  const templates = templatesQuery.data || [];
  const selectedTemplate = templateDetailQuery.data || null;

  return (
    <div className="space-y-4 pb-12">
      {/* 1. Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
        <div className="flex items-center gap-3">
          <button type="button" className="btn-ghost btn-sm" onClick={() => nav('/tna')}>
            <ArrowLeft size={16} /> Back to Orders
          </button>
          <div>
            <h1 className="text-xl font-bold text-ink flex items-center gap-2">
              <Layers className="text-brand-600" size={22} />
              Time & Action Activity Templates & Lead Time Master
            </h1>
            <p className="text-xs text-ink-secondary">
              Pre-configured manufacturing milestone sequences, lead-times and predecessor dependencies
            </p>
          </div>
        </div>
      </div>

      {/* 2. Layout: Left Template List, Right Activity Sequence Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Template selector cards */}
        <div className="space-y-2.5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-ink-secondary px-1">
            Standard Garment Workflows
          </h3>
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              onClick={() => setSelectedTplId(tpl.id)}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all shadow-xs ${
                selectedTplId === tpl.id
                  ? 'bg-brand-50/70 border-brand-500 ring-1 ring-brand-500'
                  : 'bg-white border-surface-border hover:border-surface-input'
              }`}
            >
              <div className="flex justify-between items-start">
                <span className="tabular-nums text-caption font-bold text-ink-muted">{tpl.template_code}</span>
                <span className="rounded bg-indigo-50 border border-indigo-200 px-1.5 py-0.2 text-micro font-bold text-indigo-700">
                  {tpl.product_type}
                </span>
              </div>
              <h4 className="font-bold text-ink mt-1 text-sm">{tpl.template_name}</h4>
              <p className="text-caption text-ink-secondary mt-1 line-clamp-2">{tpl.description}</p>
              <div className="flex justify-between items-center mt-3 pt-2 border-t border-surface-divider text-caption text-ink-secondary">
                <span>{tpl.activity_count || 21} Activities</span>
                <span className="font-semibold text-brand-600 flex items-center gap-0.5">
                  View Sequence <ChevronRight size={13} />
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Right: Selected Template Activity Sequence */}
        <div className="md:col-span-2 rounded-xl border border-surface-border bg-white shadow-xs overflow-hidden">
          <div className="p-4 bg-surface-muted border-b border-surface-border flex justify-between items-center">
            <div>
              <h3 className="font-bold text-ink text-sm">
                {selectedTemplate?.template_name || 'Loading sequence…'}
              </h3>
              <p className="text-xs text-ink-secondary">{selectedTemplate?.description}</p>
            </div>
            <span className="rounded-full bg-emerald-100 text-emerald-800 font-bold px-2.5 py-0.5 text-xs">
              Active Template
            </span>
          </div>

          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-surface-header/80 border-b border-surface-border text-ink-secondary font-semibold uppercase tracking-wider text-caption sticky top-0">
                <tr>
                  <th className="py-2.5 px-3 w-12 text-center">Seq</th>
                  <th className="py-2.5 px-3">Milestone Activity</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3 text-center">Duration</th>
                  <th className="py-2.5 px-3">Department</th>
                  <th className="py-2.5 px-3">Default Owner</th>
                  <th className="py-2.5 px-3 text-center">Prerequisite</th>
                  <th className="py-2.5 px-3 text-center">Mandatory</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-divider text-ink">
                {(!selectedTemplate?.activities || selectedTemplate.activities.length === 0) ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-ink-muted">
                      Loading activity sequence…
                    </td>
                  </tr>
                ) : (
                  selectedTemplate.activities.map((act: any) => (
                    <tr key={act.id} className="hover:bg-surface-muted/80 transition-colors">
                      <td className="py-2.5 px-3 text-center tabular-nums font-medium text-ink-secondary">
                        {act.sequence_no}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-ink">
                        {act.activity_name}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="rounded px-1.5 py-0.5 text-micro font-semibold bg-surface-header text-ink">
                          {act.category}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center tabular-nums font-bold text-indigo-700">
                        {act.default_duration} {act.duration_uom || 'days'}
                      </td>
                      <td className="py-2.5 px-3 text-ink-secondary">
                        {act.department_name || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-ink-secondary">
                        {act.default_owner_role || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-center tabular-nums text-ink-secondary">
                        {act.dependency_sequence ? `Seq #${act.dependency_sequence}` : 'None (Start)'}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {Boolean(act.mandatory) ? (
                          <span className="text-emerald-700 font-bold">Yes</span>
                        ) : (
                          <span className="text-ink-muted">Optional</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
