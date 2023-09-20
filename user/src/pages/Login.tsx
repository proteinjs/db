import React from 'react';
import { Page, Form, Fields, textField, FormButtons, clearButton, FormPage } from '@proteinjs/ui';
import { login } from '../routes/login';

export const loginPage: Page = {
    name: 'Login',
    path: 'login',
    public: true,
    component: () => (
        <FormPage>
            <Form<LoginFields, typeof buttons>
                name='Login'
                createFields={() => new LoginFields()}
                fieldLayout={['email', 'password']}
                buttons={buttons}
            />
        </FormPage>
    )
}

class LoginFields extends Fields {
    static create() {
        return new LoginFields();
    }

    email = textField<LoginFields>({
        name: 'email'
    });

    password = textField<LoginFields>({
        name: 'password',
        isPassword: true
    });
}

const buttons: FormButtons<LoginFields> = {
	clear: clearButton,
	login: {
		name: 'Login',
		style: {
			color: 'primary',
			border: true
		},
		onClick: async (fields: LoginFields, buttons: FormButtons<LoginFields>) => {
			const response = await fetch(login.path, {
                method: login.method,
                body: JSON.stringify({
                    email: fields.email.field.value,
                    password: fields.password.field.value
                }),
                redirect: 'follow',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            if (response.status != 200)
                throw new Error(`Failed to login, error: ${response.statusText}`);

            const body = await response.json();
            if (body.error)
                throw new Error(body.error);

            window.location.href = '/';
		}
	}
};