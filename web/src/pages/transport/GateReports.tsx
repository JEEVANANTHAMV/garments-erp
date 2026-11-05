/**
 * Gate & transport reports (client voice notes 04-Nov-2026 clip 2: "a report for visitors, likewise reports for vehicles";
 * transport spec §10). Built on the client report kit: filters → table → totals → Excel. Route /gate/reports
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportSection, type ReportDef, type ReportFilter } from '../reports/clientReportKit';
import { ImageThumbnail } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { useRequestTypes } from './transportShared';

const ymd = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const TODAY = ymd(new Date());
const MONTH_AGO = ymd(new Date(Date.now() - 29 * 86_400_000));
const FROM: ReportFilter = { key: 'from', label: 'From', type: 'date', default: MONTH_AGO };
const TO: ReportFilter = { key: 'to', label: 'To', type: 'date', default: TODAY };
const opt = (xs: string[]) => xs.map((x) => ({ value: x, label: x.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }));
const REQ_STATUS = opt(['SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED', 'APPROVED', 'REJECTED', 'ASSIGNED', 'IN_PROGRESS', 'PICKUP_COMPLETED', 'DELIVERED', 'COMPLETED', 'CANCELLED']);
const TRIP_STATUS = opt(['ASSIGNED', 'DRIVER_ACCEPTED', 'STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXCEPTION']);
const OWNERSHIP: ReportFilter = { key: 'ownership_type', label: 'Owned / rental', type: 'select', options: opt(['OWNED', 'RENTAL']) };
const reqLink = (r: any) => `/transport/requests/${r.id}`;
const tripLink = (r: any) => `/transport/trips/${r.id}`;

export function GateReportsPage() {
  const { canAny } = useAuth();
  const gate = canAny('GATE_INWARD.VIEW', 'TRANSPORT.VIEW');
  const transport = canAny('TRANSPORT.VIEW');
  const types = useRequestTypes(true);
  const vehicles = useQuery({ queryKey: ['transport', 'vehicles', 'report'], enabled: transport, queryFn: async () => (await http.get<{ data: any[] }>('/transport/vehicles')).data });
  const drivers = useQuery({ queryKey: ['transport', 'drivers', 'report'], enabled: transport, queryFn: async () => (await http.get<{ data: any[] }>('/transport/drivers')).data });

  const defs = useMemo<ReportDef[]>(() => {
    const TYPE: ReportFilter = { key: 'request_type_id', label: 'Request type', type: 'select', options: (types.data ?? []).map((t) => ({ value: t.id, label: t.type_name })) };
    const VEH: ReportFilter = { key: 'vehicle_id', label: 'Vehicle', type: 'select', options: (vehicles.data ?? []).map((v) => ({ value: v.id, label: v.registration_no })) };
    const DRV: ReportFilter = { key: 'driver_id', label: 'Driver', type: 'select', options: (drivers.data ?? []).map((d) => ({ value: d.id, label: d.driver_name })) };
    const DEPT: ReportFilter = { key: 'department_id', label: 'Department', type: 'select', lookup: 'departments' };
    const REQUESTER: ReportFilter = { key: 'requested_by', label: 'Requester', type: 'select', lookup: 'users' };
    const PRIORITY: ReportFilter = { key: 'priority', label: 'Priority', type: 'select', options: opt(['NORMAL', 'URGENT', 'CRITICAL']) };
    const out: ReportDef[] = [];
    if (gate) out.push({
      key: 'visitors', title: 'Visitor Report', subtitle: 'Visitors and contractors through the gate — in / out time, duration, still inside, photo',
      endpoint: '/gate-reports/visitors',
      filters: [FROM, TO, { key: 'visitor_type', label: 'Type', type: 'select', options: opt(['VISITOR', 'CONTRACTOR']) },
        { key: 'inside', label: 'Still inside', type: 'select', options: [{ value: 'Y', label: 'Still inside only' }] },
        { key: 'department_id', label: 'Host department', type: 'select', lookup: 'departments' },
        { key: 'purpose', label: 'Purpose', type: 'text' }, { key: 'company', label: 'Company', type: 'text' }, { key: 'host', label: 'Whom to meet', type: 'text' }],
      columns: [
        { key: 'photo_url', header: 'Photo', render: (r) => <ImageThumbnail url={r.photo_url} title={r.person_name} size="sm" />, exportValue: (r) => (r.photo_url ? `${window.location.origin}${r.photo_url}` : '') },
        { key: 'entry_no', header: 'Entry No', link: () => '/gate/visitors' },
        { key: 'visit_date', header: 'Date', type: 'date' },
        { key: 'visitor_type', header: 'Type' },
        { key: 'person_name', header: 'Name' },
        { key: 'person_count', header: 'Persons', type: 'int', total: true },
        { key: 'company', header: 'Company' },
        { key: 'phone', header: 'Phone' },
        { key: 'purpose', header: 'Purpose' },
        { key: 'whom_to_meet', header: 'Whom to meet' },
        { key: 'department', header: 'Department' },
        { key: 'in_time', header: 'In' },
        { key: 'out_time', header: 'Out' },
        { key: 'duration', header: 'Duration' },
        { key: 'duration_min', header: 'Minutes', type: 'int', total: true },
        { key: 'still_inside', header: 'Still inside', type: 'yn' },
        { key: 'vehicle_no', header: 'Vehicle' },
        { key: 'id_proof', header: 'ID proof' },
        { key: 'security_guard', header: 'Security' },
      ],
    });
    if (transport) out.push(
      {
        key: 'transport-requests', title: 'Transport Request Register', subtitle: 'Every vehicle request with approval time, ageing, turnaround, trip, vehicle and driver',
        endpoint: '/gate-reports/transport-requests', filters: [FROM, TO, DEPT, REQUESTER, TYPE, PRIORITY, { key: 'status', label: 'Status', type: 'select', options: REQ_STATUS }],
        columns: [
          { key: 'request_no', header: 'Request', link: reqLink }, { key: 'required_at', header: 'Needed at' }, { key: 'type_name', header: 'Type' }, { key: 'priority', header: 'Priority' },
          { key: 'status', header: 'Status' }, { key: 'requester', header: 'Requester' }, { key: 'department', header: 'Department' }, { key: 'purpose', header: 'Purpose' },
          { key: 'pickup', header: 'Pickup' }, { key: 'destination', header: 'Destination' }, { key: 'package_qty', header: 'Pkgs', type: 'qty', total: true },
          { key: 'submitted_at', header: 'Submitted' }, { key: 'approver', header: 'Approved by' }, { key: 'approval_hours', header: 'Approval hrs', type: 'qty' },
          { key: 'ageing_hours', header: 'Ageing hrs', type: 'qty' }, { key: 'turnaround_hours', header: 'Turnaround hrs', type: 'qty' },
          { key: 'trip_no', header: 'Trip' }, { key: 'vehicle_no', header: 'Vehicle' }, { key: 'ownership', header: 'Own / rent' }, { key: 'driver', header: 'Driver' }, { key: 'reason', header: 'Reject / cancel reason' },
        ],
      },
      {
        key: 'pending-requests', title: 'Pending / Delayed Requests', subtitle: 'Open requests by how late they are against the required time',
        endpoint: '/gate-reports/pending-requests', filters: [DEPT, TYPE, PRIORITY],
        columns: [
          { key: 'request_no', header: 'Request', link: reqLink }, { key: 'required_at', header: 'Needed at' }, { key: 'delayed', header: 'Delayed', type: 'yn' },
          { key: 'overdue_hours', header: 'Overdue hrs', type: 'qty' }, { key: 'ageing_hours', header: 'Ageing hrs', type: 'qty' }, { key: 'status', header: 'Status' },
          { key: 'priority', header: 'Priority' }, { key: 'type_name', header: 'Type' }, { key: 'requester', header: 'Requester' }, { key: 'department', header: 'Department' },
          { key: 'delay_reason', header: 'Delay reason' }, { key: 'coordinator', header: 'Coordinator' }, { key: 'trip_no', header: 'Trip' }, { key: 'vehicle_no', header: 'Vehicle' }, { key: 'driver', header: 'Driver' },
        ],
      },
      {
        key: 'requests-by-department', title: 'Requests by Department / Requester', subtitle: 'Who asks for vehicles and how they were handled',
        endpoint: '/gate-reports/requests-by-department', filters: [FROM, TO, DEPT, TYPE],
        columns: [
          { key: 'department', header: 'Department' }, { key: 'requester', header: 'Requester' }, { key: 'total', header: 'Requests', type: 'int', total: true },
          { key: 'completed', header: 'Completed', type: 'int', total: true }, { key: 'open', header: 'Open', type: 'int', total: true }, { key: 'rejected', header: 'Rejected', type: 'int', total: true },
          { key: 'cancelled', header: 'Cancelled', type: 'int', total: true }, { key: 'urgent', header: 'Urgent / critical', type: 'int', total: true }, { key: 'avg_turnaround_hours', header: 'Avg turnaround hrs', type: 'qty' },
        ],
      },
      {
        key: 'trip-sheet', title: 'Daily Trip Sheet', subtitle: 'Trips by date, driver and vehicle — planned vs actual times, stops and km',
        endpoint: '/gate-reports/trip-sheet', filters: [FROM, TO, VEH, DRV, OWNERSHIP, { key: 'status', label: 'Status', type: 'select', options: TRIP_STATUS }],
        columns: [
          { key: 'trip_no', header: 'Trip', link: tripLink }, { key: 'trip_date', header: 'Date' }, { key: 'status', header: 'Status' }, { key: 'vehicle_no', header: 'Vehicle' },
          { key: 'ownership', header: 'Own / rent' }, { key: 'driver', header: 'Driver' }, { key: 'purpose', header: 'Purpose' }, { key: 'planned_start', header: 'Planned start' },
          { key: 'planned_end', header: 'Planned end' }, { key: 'actual_start', header: 'Actual start' }, { key: 'actual_end', header: 'Actual end' },
          { key: 'start_delay_min', header: 'Start delay min', type: 'int' }, { key: 'planned_hours', header: 'Planned hrs', type: 'qty', total: true }, { key: 'actual_hours', header: 'Actual hrs', type: 'qty', total: true },
          { key: 'stops', header: 'Stops', type: 'int', total: true }, { key: 'stops_completed', header: 'Done', type: 'int', total: true }, { key: 'stops_failed', header: 'Failed', type: 'int', total: true },
          { key: 'requests', header: 'Requests', type: 'int', total: true }, { key: 'request_nos', header: 'Request nos' }, { key: 'km', header: 'Km', type: 'qty', total: true },
          { key: 'issues', header: 'Issues', type: 'int', total: true }, { key: 'exception', header: 'Exception', type: 'yn' }, { key: 'remarks', header: 'Remarks' },
        ],
      },
      {
        key: 'vehicle-utilisation', title: 'Vehicle Utilisation', subtitle: 'Per vehicle (owned / rental): trips, assigned and actual hours, km, issues',
        endpoint: '/gate-reports/vehicle-utilisation', filters: [FROM, TO, VEH, OWNERSHIP],
        columns: [
          { key: 'vehicle_no', header: 'Vehicle' }, { key: 'vehicle_type', header: 'Type' }, { key: 'ownership', header: 'Own / rent' }, { key: 'rental_provider', header: 'Provider' },
          { key: 'current_status', header: 'Status now' }, { key: 'trips', header: 'Trips', type: 'int', total: true }, { key: 'completed', header: 'Completed', type: 'int', total: true },
          { key: 'cancelled', header: 'Cancelled', type: 'int', total: true }, { key: 'in_progress', header: 'Active', type: 'int', total: true },
          { key: 'assigned_hours', header: 'Assigned hrs', type: 'qty', total: true }, { key: 'actual_hours', header: 'Actual hrs', type: 'qty', total: true },
          { key: 'km', header: 'Km', type: 'qty', total: true }, { key: 'issues', header: 'Issues', type: 'int', total: true }, { key: 'utilisation_pct', header: 'Utilisation', type: 'pct' },
        ],
      },
      {
        key: 'driver-utilisation', title: 'Driver Utilisation', subtitle: 'Per driver: trips, hours, rejections and issues',
        endpoint: '/gate-reports/driver-utilisation', filters: [FROM, TO, DRV],
        columns: [
          { key: 'driver', header: 'Driver' }, { key: 'mobile', header: 'Mobile' }, { key: 'licence_expiry', header: 'Licence expiry', type: 'date' }, { key: 'current_status', header: 'Status now' },
          { key: 'trips', header: 'Trips', type: 'int', total: true }, { key: 'completed', header: 'Completed', type: 'int', total: true }, { key: 'cancelled', header: 'Cancelled', type: 'int', total: true },
          { key: 'rejections', header: 'Rejected by driver', type: 'int', total: true }, { key: 'assigned_hours', header: 'Assigned hrs', type: 'qty', total: true },
          { key: 'actual_hours', header: 'Actual hrs', type: 'qty', total: true }, { key: 'km', header: 'Km', type: 'qty', total: true }, { key: 'issues', header: 'Issues', type: 'int', total: true },
        ],
      },
      {
        key: 'service-performance', title: 'Pickup & Delivery Performance', subtitle: 'On-time rate, average completion and failed / partial service by request type',
        endpoint: '/gate-reports/service-performance', filters: [FROM, TO, DEPT, TYPE],
        columns: [
          { key: 'request_type', header: 'Request type' }, { key: 'requests', header: 'Requests', type: 'int', total: true }, { key: 'completed', header: 'Completed', type: 'int', total: true },
          { key: 'on_time', header: 'On time', type: 'int', total: true }, { key: 'on_time_pct', header: 'On-time %', type: 'pct' }, { key: 'avg_completion_hours', header: 'Avg completion hrs', type: 'qty' },
          { key: 'pickups_done', header: 'Pickups done', type: 'int', total: true }, { key: 'deliveries_done', header: 'Deliveries done', type: 'int', total: true },
          { key: 'partial', header: 'Partial', type: 'int', total: true }, { key: 'failed', header: 'Failed', type: 'int', total: true },
        ],
      },
    );
    return out;
  }, [gate, transport, types.data, vehicles.data, drivers.data]);

  if (!defs.length) return <p className="text-body text-ink-secondary">You do not have access to gate or transport reports.</p>;
  return <ReportSection title="Security & Transport Reports" subtitle="Visitors, vehicle requests, trips and fleet use — filter, then export to Excel" defs={defs} />;
}
