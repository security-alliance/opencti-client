import { StixBundle } from "@security-alliance/stix/2.1";
import { BaseOpenCTIClient, File_All, Maybe, MutationStixCyberObservableAddArgs } from "./generated/graphql.js";
import { OpenCTIStream, OpenCTIStreamOptions } from "./sync.js";
import { sleep } from "./utils.js";

export * from "./generated/graphql.js";

export type SCOEntityTypes = {
    Artifact: "Artifact";
    "Autonomous-System": "AutonomousSystem";
    "Bank-Account": "BankAccount";
    Credential: "Credential";
    "Cryptocurrency-Wallet": "CryptocurrencyWallet";
    "Cryptographic-Key": "CryptographicKey";
    Directory: "Directory";
    "Domain-Name": "DomainName";
    "Email-Addr": "EmailAddr";
    "Email-Message": "EmailMessage";
    "Email-Mime-Part-Type": "EmailMimePartType";
    Hostname: "Hostname";
    "IPv4-Addr": "IPv4Addr";
    "IPv6-Addr": "IPv6Addr";
    "Mac-Addr": "MacAddr";
    "Media-Content": "MediaContent";
    Mutex: "Mutex";
    "Network-Traffic": "NetworkTraffic";
    "Payment-Card": "PaymentCard";
    Persona: "Persona";
    "Phone-Number": "PhoneNumber";
    Process: "Process";
    Software: "Software";
    StixFile: "StixFile";
    Text: "Text";
    "Tracking-Number": "TrackingNumber";
    Url: "Url";
    "User-Account": "UserAccount";
    "User-Agent": "UserAgent";
    "Windows-Registry-Key": "WindowsRegistryKey";
    "Windows-Registry-Value-Type": "WindowsRegistryValueType";
    "X509-Certificate": "X509Certificate";
};

export class OpenCTIClient extends BaseOpenCTIClient {
    constructor(host: string, apiKey: string) {
        super(host, apiKey);
    }

    public async stixCyberObservableAddTyped<T extends keyof SCOEntityTypes>(
        type: T,
        args: Omit<MutationStixCyberObservableAddArgs, "type" | SCOEntityTypes[Exclude<keyof SCOEntityTypes, T>]>,
    ) {
        return this.stixCyberObservableAdd({
            ...args,
            type: type,
        });
    }

    public async importSTIXBundle(bundle: StixBundle): Promise<Maybe<File_All>> {
        const connectors = await this.connectorsForImport();

        const stixConnector = connectors.find((connector) => connector?.name === "ImportFileStix");
        if (!stixConnector) {
            return undefined;
        }

        const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
        (blob as any).name = `${bundle.id}.json`;

        const uploadPendingFileResult = await this.uploadPending({
            file: blob,
            entityId: null,
        });

        const fileId = uploadPendingFileResult!.id;

        const askJobImportResult = await this.askJobImport({
            fileName: fileId,
            connectorId: stixConnector.id,
            bypassValidation: true,
            configuration: null,
        });

        return askJobImportResult;
    }

    public async waitForImportSTIXBundle(importedFileId: string, signal?: AbortSignal): Promise<void> {
        let workId: string = "";

        while (!signal?.aborted) {
            const file = (await this.file({ id: importedFileId }))!;

            if (file.works.length === 0) {
                await sleep(1000, signal);
                continue;
            }

            workId = file.works[file.works.length - 1]!.id;
            break;
        }

        while (!signal?.aborted) {
            const work = (await this.work({ id: workId }))!;

            const { import_expected_number: expected, import_processed_number: processed } = work.tracking!;

            if (expected === null || processed === null || expected !== processed) {
                await sleep(1000, signal);
                continue;
            }

            break;
        }
    }

    public openStream(streamId: string, options?: Omit<OpenCTIStreamOptions, "authorization">): OpenCTIStream {
        return new OpenCTIStream(new URL(`${this.host}/stream/${streamId}`), {
            ...options,
            authorization: this.apiKey,
        });
    }
}
