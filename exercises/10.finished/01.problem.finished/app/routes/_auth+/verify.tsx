import { conform, useForm, type Submission } from '@conform-to/react'
import { getFieldsetConstraint, parse } from '@conform-to/zod'
import { json, type DataFunctionArgs } from '@remix-run/node'
import {
	Form,
	useFetcher,
	useLoaderData,
	useSearchParams,
} from '@remix-run/react'
import { z } from 'zod'
import { ErrorList, Field } from '~/components/forms.tsx'
import { StatusButton } from '~/components/ui/status-button.tsx'
import { handleVerification as handleChangeEmailVerification } from '~/routes/settings+/profile.change-email.tsx'
import { prisma } from '~/utils/db.server.ts'
import { getDomainUrl, useIsSubmitting } from '~/utils/misc.tsx'
import { generateTOTP, verifyTOTP } from '~/utils/totp.server.ts'
import { handleVerification as handleForgotPasswordVerification } from './forgot-password.tsx'
import { handleVerification as handleOnboardingVerification } from './onboarding.tsx'
import { Spacer } from '~/components/spacer.tsx'

export const codeQueryParam = 'code'
export const targetQueryParam = 'target'
export const typeQueryParam = 'type'
export const redirectToQueryParam = 'redirectTo'
const types = ['forgot-password', 'onboarding', 'change-email'] as const
export type VerificationTypes = (typeof types)[number]

const typeOTPConfig: Record<VerificationTypes, { window: number }> = {
	'forgot-password': { window: 0 },
	onboarding: { window: 0 },
	'change-email': { window: 0 },
}

const VerifySchema = z.object({
	[codeQueryParam]: z.string().min(6).max(6),
	[typeQueryParam]: z.enum(types),
	[targetQueryParam]: z.string(),
	[redirectToQueryParam]: z.string().optional(),
})

export async function loader({ request }: DataFunctionArgs) {
	const params = new URL(request.url).searchParams
	if (!params.has(codeQueryParam)) {
		// we don't want to show an error message on page load if the otp hasn't be
		// prefilled in yet, so we'll send a response with an empty submission.
		return json({
			status: 'idle',
			submission: {
				intent: '',
				payload: Object.fromEntries(params),
				error: {},
			},
		} as const)
	}
	return validateRequest(request, params)
}

export async function action({ request }: DataFunctionArgs) {
	return validateRequest(request, await request.formData())
}

export function getRedirectToUrl({
	request,
	type,
	target,
}: {
	request: Request
	type: VerificationTypes
	target: string
}) {
	const redirectToUrl = new URL(`${getDomainUrl(request)}/verify`)
	redirectToUrl.searchParams.set(typeQueryParam, type)
	redirectToUrl.searchParams.set(targetQueryParam, target)
	return redirectToUrl
}

export async function prepareVerification({
	period,
	request,
	type,
	target,
}: {
	period: number
	request: Request
	type: VerificationTypes
	target: string
}) {
	const verifyUrl = getRedirectToUrl({ request, type, target })
	const redirectTo = new URL(verifyUrl.toString())

	const { otp, ...otpConfig } = generateTOTP({ algorithm: 'SHA256', period })
	// delete old verifications. Users should not have more than one verification
	// of a specific type for a specific target at a time.
	await prisma.verification.deleteMany({ where: { type, target } })
	await prisma.verification.create({
		data: {
			type,
			target,
			...otpConfig,
			expiresAt: new Date(Date.now() + otpConfig.period * 1000),
		},
	})

	// add the otp to the url we'll email the user.
	verifyUrl.searchParams.set(codeQueryParam, otp)

	return { otp, redirectTo, verifyUrl }
}

export type VerifyFunctionArgs = {
	request: Request
	submission: Submission<z.infer<typeof VerifySchema>>
	body: FormData | URLSearchParams
}

async function isCodeValid({
	code,
	type,
	target,
}: {
	code: string
	type: VerificationTypes
	target: string
}) {
	const verification = await prisma.verification.findFirst({
		where: {
			OR: [
				{ type, target, expiresAt: { gt: new Date() } },
				{ type, target, expiresAt: null },
			],
		},
		select: { algorithm: true, secret: true, period: true },
	})
	if (!verification) return false
	const result = verifyTOTP({
		otp: code,
		secret: verification.secret,
		algorithm: verification.algorithm,
		period: verification.period,
		...typeOTPConfig[type],
	})
	if (!result) return false

	return true
}

async function validateRequest(
	request: Request,
	body: URLSearchParams | FormData,
) {
	const submission = await parse(body, {
		schema: () =>
			VerifySchema.superRefine(async (data, ctx) => {
				const codeIsValid = await isCodeValid({
					code: data[codeQueryParam],
					type: data[typeQueryParam],
					target: data[targetQueryParam],
				})
				if (!codeIsValid) {
					ctx.addIssue({
						path: ['code'],
						code: z.ZodIssueCode.custom,
						message: `Invalid code`,
					})
					return
				}
			}),
		acceptMultipleErrors: () => true,
		async: true,
	})

	if (submission.intent !== 'submit') {
		return json({ status: 'idle', submission } as const)
	}
	if (!submission.value) {
		return json({ status: 'error', submission } as const, { status: 400 })
	}

	const { value: submissionValue } = submission

	await prisma.verification.delete({
		where: {
			target_type: {
				type: submissionValue[typeQueryParam],
				target: submissionValue[targetQueryParam],
			},
		},
	})

	switch (submissionValue[typeQueryParam]) {
		case 'forgot-password': {
			return handleForgotPasswordVerification({ request, body, submission })
		}
		case 'onboarding': {
			return handleOnboardingVerification({ request, body, submission })
		}
		case 'change-email': {
			return await handleChangeEmailVerification({ request, body, submission })
		}
	}
}

export default function VerifyRoute() {
	const data = useLoaderData<typeof loader>()
	const [searchParams] = useSearchParams()
	const isSubmitting = useIsSubmitting()
	const verifyFetcher = useFetcher<typeof action>()

	const [form, fields] = useForm({
		id: 'verify-form',
		constraint: getFieldsetConstraint(VerifySchema),
		lastSubmission: verifyFetcher.data?.submission ?? data.submission,
		onValidate({ formData }) {
			return parse(formData, { schema: VerifySchema })
		},
		defaultValue: {
			code: searchParams.get('code') ?? '',
			type: searchParams.get('type') ?? '',
			target: searchParams.get('target') ?? '',
			redirectTo: searchParams.get('redirectTo') ?? '',
		},
	})

	return (
		<div className="container flex flex-col justify-center pb-32 pt-20">
			<div className="text-center">
				<h1 className="text-h1">Check your email</h1>
				<p className="mt-3 text-body-md text-muted-foreground">
					We've sent you a code to verify your email address.
				</p>
			</div>

			<Spacer size="xs" />

			<div className="mx-auto flex flex-col justify-center gap-1 w-72 max-w-full">
				<div>
					<ErrorList errors={form.errors} id={form.errorId} />
				</div>
				<div className="flex w-full gap-2">
					<Form method="POST" {...form.props} className="flex-1">
						<Field
							labelProps={{
								htmlFor: fields[codeQueryParam].id,
								children: 'Code',
							}}
							inputProps={conform.input(fields[codeQueryParam])}
							errors={fields[codeQueryParam].errors}
						/>
						<input
							{...conform.input(fields[typeQueryParam], { type: 'hidden' })}
						/>
						<input
							{...conform.input(fields[targetQueryParam], { type: 'hidden' })}
						/>
						<input
							{...conform.input(fields[redirectToQueryParam], {
								type: 'hidden',
							})}
						/>
						<StatusButton
							className="w-full"
							status={
								isSubmitting ? 'pending' : verifyFetcher.data?.status ?? 'idle'
							}
							type="submit"
							disabled={isSubmitting}
						>
							Submit
						</StatusButton>
					</Form>
				</div>
			</div>
		</div>
	)
}
