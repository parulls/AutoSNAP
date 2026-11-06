export type Item = { id: string; kind: string; name: string; parentId: string | null; partnerId: string | null; data: Record<string, unknown>; createdAt: string; updatedAt: string };
export type Scenario = { id: string; group: string; service: string; scenario: string; expected: string; expectedCode: string | null };
export type Run = { id: string; client_id: string; project_id: string; environment_id: string; user_id: string | null; service_id: string; endpoint_id: string; scenario_id: string | null; mode: string; status: string; http_status: number | null; response_code: string | null; expected_code: string | null; duration_ms: number | null; request: unknown; response: unknown; notes: string; created_at: string };
export type Operator={id:string;username:string;email?:string;name:string;role:"admin"|"tester";active:boolean;createdAt?:string};
export type State = { user?: Operator; setupRequired?: boolean; setupTokenRequired?: boolean; recaptchaConfigured?:boolean; recaptchaSiteKey?:string; records: Item[]; runs: Run[]; scenarios: Scenario[]; operators?:Operator[] };
export type Api=(action:string,payload?:Record<string,unknown>)=>Promise<Record<string,unknown>>;
